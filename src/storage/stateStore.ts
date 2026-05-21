import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppState, DashboardAuditLogEntry, GuildSettings, PlaybackHistoryEntry, Playlist, PremiumUserSettings, StoredGuildPlayerState, VoiceChannelHistoryEntry } from "../types.js";

const dataDir = path.resolve(process.cwd(), "data");
const statePath = path.join(dataDir, "state.json");
const playbackHistoryRetentionMs = 14 * 24 * 60 * 60 * 1000;

const defaultState: AppState = { 
  guildSettings: {}, 
  guildPlayers: {}, 
  playlists: {}, 
  voiceChannelHistory: {}, 
  settingsAuditLogs: {}, 
  songHistory: {}, 
  globalDeniedUserIds: [],
  premiumUsers: {}
}; 

export class StateStore {
  private state: AppState = structuredClone(defaultState);
  private ready = false;
  private flushChain = Promise.resolve();

  async init() {
    if (this.ready) {
      return;
    }

    await mkdir(dataDir, { recursive: true });

    try {
      const raw = await readFile(statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppState>;
      this.state = { 
        ...defaultState, 
        ...parsed,  
        playlists: this.normalizePlaylists(parsed.playlists),  
        voiceChannelHistory: parsed.voiceChannelHistory ?? {},  
        settingsAuditLogs: parsed.settingsAuditLogs ?? {},  
        songHistory: parsed.songHistory ?? {},  
        globalDeniedUserIds: Array.isArray(parsed.globalDeniedUserIds) ? [...new Set(parsed.globalDeniedUserIds)] : [],
        premiumUsers: this.normalizePremiumUsers(parsed.premiumUsers)
      };  
      this.pruneSongHistory();
    } catch {
      await this.flush();
    }

    this.ready = true;
  }

  getGuildSettings(guildId: string): GuildSettings | undefined {
    return this.state.guildSettings[guildId];
  }

  async setGuildSettings(settings: GuildSettings) { 
    this.state.guildSettings[settings.guildId] = settings; 
    await this.flush(); 
  } 
 
  getGlobalDeniedUserIds() { 
    return [...this.state.globalDeniedUserIds]; 
  } 
 
  async setGlobalDeniedUserIds(userIds: string[]) { 
    this.state.globalDeniedUserIds = [...new Set(userIds)].sort((left, right) => left.localeCompare(right)); 
    await this.flush(); 
  } 

  getPremiumUser(userId: string): PremiumUserSettings | undefined {
    const settings = this.state.premiumUsers[userId];
    return settings ? { ...settings } : undefined;
  }

  getPremiumUsers() {
    return Object.values(this.state.premiumUsers)
      .map((settings) => ({ ...settings }))
      .sort((left, right) => left.userId.localeCompare(right.userId));
  }

  async setPremiumUser(settings: PremiumUserSettings) {
    this.state.premiumUsers[settings.userId] = { ...settings };
    await this.flush();
  }
 
  getGuildPlayer(guildId: string): StoredGuildPlayerState | undefined { 
    return this.state.guildPlayers[guildId];
  }

  async setGuildPlayer(player: StoredGuildPlayerState) {
    this.state.guildPlayers[player.guildId] = player;
    await this.flush();
  }

  async deleteGuildPlayer(guildId: string) {
    delete this.state.guildPlayers[guildId];
    await this.flush();
  }

  getVoiceChannelHistory(guildId: string): VoiceChannelHistoryEntry[] {
    return [...(this.state.voiceChannelHistory[guildId] ?? [])];
  }

  async addVoiceChannelHistory(entry: VoiceChannelHistoryEntry, limit = 80) {
    const history = [entry, ...(this.state.voiceChannelHistory[entry.guildId] ?? [])].slice(0, limit);
    this.state.voiceChannelHistory[entry.guildId] = history;
    await this.flush();
  }

  getSettingsAuditLogs(guildId: string): DashboardAuditLogEntry[] {
    return [...(this.state.settingsAuditLogs[guildId] ?? [])];
  }

  async addSettingsAuditLogs(guildId: string, entries: DashboardAuditLogEntry[], limit = 200) {
    if (!entries.length) {
      return;
    }

    this.state.settingsAuditLogs[guildId] = [
      ...entries,
      ...(this.state.settingsAuditLogs[guildId] ?? [])
    ].slice(0, limit);
    await this.flush();
  }

  getSongHistory(guildId: string, days = 14): PlaybackHistoryEntry[] {
    const cutoff = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000;
    return [...(this.state.songHistory[guildId] ?? [])]
      .filter((entry) => Date.parse(entry.playedAt) >= cutoff)
      .sort((left, right) => Date.parse(right.playedAt) - Date.parse(left.playedAt));
  }

  async addSongHistory(entry: PlaybackHistoryEntry, limit = 1000) {
    const history = [entry, ...(this.state.songHistory[entry.guildId] ?? [])]
      .filter((candidate) => Date.now() - Date.parse(candidate.playedAt) <= playbackHistoryRetentionMs)
      .sort((left, right) => Date.parse(right.playedAt) - Date.parse(left.playedAt))
      .slice(0, limit);
    this.state.songHistory[entry.guildId] = history;
    this.pruneSongHistory();
    await this.flush();
  }

  getPlaylists(ownerId: string): Playlist[] { 
    return Object.values(this.state.playlists[ownerId] ?? {}).sort((a, b) => 
      a.name.localeCompare(b.name) 
    ); 
  } 

  getAllPlaylists(): Playlist[] { 
    return Object.values(this.state.playlists) 
      .flatMap((playlistsByName) => Object.values(playlistsByName)) 
      .sort((a, b) => a.createdById.localeCompare(b.createdById) || a.name.localeCompare(b.name)); 
  } 

  getPlaylist(ownerId: string, name: string): Playlist | undefined { 
    return this.state.playlists[ownerId]?.[name.toLowerCase()]; 
  } 

  async setPlaylist(playlist: Playlist) { 
    this.state.playlists[playlist.createdById] ??= {}; 
    this.state.playlists[playlist.createdById][playlist.name.toLowerCase()] = playlist; 
    await this.flush(); 
  } 

  async deletePlaylist(ownerId: string, name: string) { 
    delete this.state.playlists[ownerId]?.[name.toLowerCase()]; 
    await this.flush(); 
  } 

  private normalizePlaylists(playlists: unknown): AppState["playlists"] { 
    if (typeof playlists !== "object" || playlists === null) { 
      return {}; 
    } 

    const normalized: AppState["playlists"] = {}; 
    const addPlaylist = (playlist: Playlist, pathKey?: string) => {
      const ownerId = playlist.createdById;
      normalized[ownerId] ??= {};
      let name = playlist.name;
      let key = name.toLowerCase();
      if (normalized[ownerId][key]) {
        const suffix = pathKey ? ` (${pathKey})` : " (migrated)";
        name = `${playlist.name}${suffix}`;
        key = name.toLowerCase();
        let duplicateIndex = 2;
        while (normalized[ownerId][key]) {
          name = `${playlist.name}${suffix} ${duplicateIndex}`;
          key = name.toLowerCase();
          duplicateIndex += 1;
        }
      }

      normalized[ownerId][key] = { ...playlist, name };
    };

    const visit = (value: unknown, path: string[]) => {
      if (this.isPlaylist(value)) {
        addPlaylist(value, path[0]);
        return;
      }

      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return;
      }

      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, [...path, key]);
      }
    };

    visit(playlists, []); 

    return normalized; 
  } 

  private normalizePremiumUsers(value: unknown): AppState["premiumUsers"] {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {};
    }

    const users: AppState["premiumUsers"] = {};
    for (const [userId, rawSettings] of Object.entries(value as Record<string, unknown>)) {
      if (typeof rawSettings !== "object" || rawSettings === null || Array.isArray(rawSettings)) {
        continue;
      }

      const settings = rawSettings as Partial<PremiumUserSettings>;
      users[userId] = {
        userId,
        personalPrefix: typeof settings.personalPrefix === "string" ? settings.personalPrefix : undefined,
        stripeCustomerId: typeof settings.stripeCustomerId === "string" ? settings.stripeCustomerId : undefined,
        stripeSubscriptionId: typeof settings.stripeSubscriptionId === "string" ? settings.stripeSubscriptionId : undefined,
        subscriptionStatus: typeof settings.subscriptionStatus === "string" ? settings.subscriptionStatus : undefined,
        currentPeriodEnd: typeof settings.currentPeriodEnd === "string" ? settings.currentPeriodEnd : undefined,
        startedAt: typeof settings.startedAt === "string"
          ? settings.startedAt
          : typeof (settings as { grantedAt?: unknown }).grantedAt === "string" ? (settings as { grantedAt: string }).grantedAt : undefined,
        updatedAt: typeof settings.updatedAt === "string" ? settings.updatedAt : new Date().toISOString()
      };
    }

    return users;
  }

  private isPlaylist(value: unknown): value is Playlist { 
    if (typeof value !== "object" || value === null) { 
      return false; 
    } 

    const candidate = value as Partial<Playlist>; 
    return typeof candidate.name === "string" 
      && typeof candidate.createdById === "string" 
      && Array.isArray(candidate.tracks); 
  } 

  private pruneSongHistory() { 
    const cutoff = Date.now() - playbackHistoryRetentionMs;
    for (const [guildId, history] of Object.entries(this.state.songHistory)) {
      const pruned = history.filter((entry) => Date.parse(entry.playedAt) >= cutoff);
      if (pruned.length) {
        this.state.songHistory[guildId] = pruned;
      } else {
        delete this.state.songHistory[guildId];
      }
    }
  }

  private async flush() {
    const payload = JSON.stringify(this.state, null, 2);
    const writeTask = this.flushChain.then(
      () => writeFile(statePath, payload, "utf8"),
      () => writeFile(statePath, payload, "utf8")
    );
    this.flushChain = writeTask.then(() => undefined, () => undefined);
    await writeTask;
  }
}
