import type { 
  ChatInputCommandInteraction,
  Client,
  Guild, 
  GuildBasedChannel,
  GuildMember, 
  Message,
  StringSelectMenuInteraction,
  VoiceBasedChannel,
  VoiceState 
} from "discord.js"; 
import { ChannelType, PermissionFlagsBits } from "discord.js"; 
import { randomUUID } from "node:crypto";
import { appConfig } from "../config.js";
import { ProviderResolver } from "./providerResolver.js";
import { GuildPlayer } from "./guildPlayer.js";
import { LavalinkService } from "./lavalinkService.js";
import { StateStore } from "../storage/stateStore.js";
import { StripeBillingService, type StripePremiumSync } from "../billing/stripeBilling.js";
import type {
  ChannelSettings,
  DashboardAuditLogEntry,
  FilterPreset,
  GuildSettings,
  MemberPermissionOverride,
  PlaybackHistoryEntry,
  Playlist,
  PremiumUserSettings,
  QueueSnapshot,
  ResolvedTrack,
  SearchResult,
  VoiceChannelHistoryEntry
} from "../types.js";

const defaultPrefix = ";";
const maxGuildPrefixes = 8;
const maxPrefixLength = 5;
const activePremiumStatuses = new Set(["active", "trialing"]);
const searchCandidateMultiplier = 4;
const maxSearchValidationCandidates = 25;
const searchValidationConcurrency = 4;
const searchValidationTimeoutMs = 2_000;

export interface PlayResult {
  tracks: ResolvedTrack[];
  playlistName?: string;
  playlistTotalTracks?: number;
}

function createDefaultGuildSettings(guildId: string): GuildSettings {
  return {
    guildId,
    prefix: defaultPrefix,
    prefixes: [defaultPrefix],
    autoplay: false,
    voteSkipEnabled: false,
    removeAfterPlayed: false,
    permissionMode: "everyone",
    disabledCommands: [],
    channelSettings: {},
    memberPermissions: {},
    privateResponsesPublic: false,
    autoDeleteBotResponses: true
  };
}

function normalizePrefixValue(value: string) {
  const prefix = value.trim();
  if (!prefix) {
    throw new Error("Prefix cannot be empty.");
  }

  if (/\s/.test(prefix)) {
    throw new Error("Prefix cannot contain spaces.");
  }

  if (prefix.length > maxPrefixLength) {
    throw new Error(`Prefix must be ${maxPrefixLength} characters or fewer.`);
  }

  return prefix;
}

function normalizePrefixes(values: string[]) {
  const prefixes = [...new Set(values.map(normalizePrefixValue))];
  if (!prefixes.length) {
    throw new Error("At least one prefix is required.");
  }

  if (prefixes.length > maxGuildPrefixes) {
    throw new Error(`A server can have at most ${maxGuildPrefixes} prefixes.`);
  }

  return prefixes;
}

function hasName(value: unknown): value is { name: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return typeof (value as { name?: unknown }).name === "string";
}

function hasMemberCount(value: unknown): value is { members: { size: number } } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const members = (value as { members?: unknown }).members;
  return typeof members === "object"
    && members !== null
    && typeof (members as { size?: unknown }).size === "number";
}

function formatSettingName(key: string) {
  return key
    .replace(/Id$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

function formatSettingValue(key: string, value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "unset";
  }

  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : "none";
  }

  if (typeof value === "boolean") {
    return value ? "on" : "off";
  }

  if (typeof value === "object") {
    const count = Object.keys(value).length;
    if (key === "channelSettings") {
      return count === 1 ? "1 channel override" : `${count} channel overrides`;
    }
    if (key === "memberPermissions") {
      return count === 1 ? "1 member override" : `${count} member overrides`;
    }
    return count ? JSON.stringify(value) : "none";
  }

  return String(value);
}

function isSameSettingValue(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export class MusicManager {
  private readonly resolver = new ProviderResolver();
  private readonly players = new Map<string, GuildPlayer>();
  private readonly voiceRegionPauseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly voteSkipVoters = new Map<string, Set<string>>();

  constructor(
    private readonly client: Client,
    private readonly store: StateStore,
    private readonly lavalink: LavalinkService
  ) {}

  async init() {
    await this.store.init();
  }

  getPrefix(guildId: string) {
    return this.getGuildSettings(guildId).prefixes[0] ?? defaultPrefix;
  }

  getPrefixes(guildId: string) {
    return [...this.getGuildSettings(guildId).prefixes];
  }

  findMatchingPrefix(guildId: string, content: string, userId?: string) {
    const premium = userId ? this.store.getPremiumUser(userId) : undefined;
    const premiumPrefix = premium && this.isPremiumSettingsActive(premium) ? premium.personalPrefix : undefined;
    return [...this.getPrefixes(guildId), ...(premiumPrefix ? [premiumPrefix] : [])]
      .sort((left, right) => right.length - left.length)
      .find((prefix) => content.startsWith(prefix));
  }

  isPremiumUser(userId: string) {
    const settings = this.store.getPremiumUser(userId);
    return Boolean(settings && this.isPremiumSettingsActive(settings));
  }

  hasPremiumSoloAccess(userId: string) {
    return this.isPremiumUser(userId) || appConfig.premiumSoloUserId === userId;
  }

  assertPremiumOrBotManagementUser(userId: string) {
    if (this.isPremiumUser(userId) || this.hasBotManagementAccess(userId)) {
      return;
    }

    throw new Error("Filters are a premium-only feature.");
  }

  getPremiumUser(userId: string): PremiumUserSettings | undefined {
    return this.store.getPremiumUser(userId);
  }

  listPremiumUsers() {
    return this.store.getPremiumUsers();
  }

  async createPremiumCheckoutUrl(userId: string) {
    return StripeBillingService.createPremiumCheckoutSession(userId);
  }

  async syncPremiumSubscription(sync: StripePremiumSync) {
    const existing = this.store.getPremiumUser(sync.userId);
    const now = new Date().toISOString();
    const next: PremiumUserSettings = {
      userId: sync.userId,
      personalPrefix: existing?.personalPrefix,
      stripeCustomerId: sync.stripeCustomerId ?? existing?.stripeCustomerId,
      stripeSubscriptionId: sync.stripeSubscriptionId ?? existing?.stripeSubscriptionId,
      subscriptionStatus: sync.subscriptionStatus,
      currentPeriodEnd: sync.currentPeriodEnd ?? existing?.currentPeriodEnd,
      startedAt: existing?.startedAt ?? (this.isSubscriptionStatusActive(sync.subscriptionStatus) ? now : undefined),
      updatedAt: now
    };
    await this.store.setPremiumUser(next);
    return next;
  }

  async setPersonalPrefix(userId: string, prefix?: string) {
    const settings = this.store.getPremiumUser(userId);
    if (!settings) {
      throw new Error("You need premium to set a personal prefix.");
    }

    const next = {
      ...settings,
      personalPrefix: prefix ? normalizePrefixValue(prefix) : undefined,
      updatedAt: new Date().toISOString()
    };
    await this.store.setPremiumUser(next);
    return next;
  }

  private isPremiumSettingsActive(settings: PremiumUserSettings) {
    return this.isSubscriptionStatusActive(settings.subscriptionStatus);
  }

  private isSubscriptionStatusActive(status: string | undefined) {
    return Boolean(status && activePremiumStatuses.has(status));
  }

  getGuildSettings(guildId: string): GuildSettings {
    const stored = this.store.getGuildSettings(guildId);
    if (!stored) {
      return createDefaultGuildSettings(guildId);
    }

    const defaults = createDefaultGuildSettings(guildId);
    const prefixes = normalizePrefixes([
      ...((Array.isArray(stored.prefixes) ? stored.prefixes : []) as string[]),
      ...(typeof stored.prefix === "string" ? [stored.prefix] : [])
    ]);

    return {
      ...defaults,
      ...stored,
      prefix: prefixes[0],
      prefixes,
      disabledCommands: [...(stored.disabledCommands ?? [])],
      channelSettings: { ...(stored.channelSettings ?? {}) },
      memberPermissions: { ...(stored.memberPermissions ?? {}) }
    };
  }

  async updateGuildSettings(guildId: string, patch: Partial<GuildSettings>) { 
    const current = this.getGuildSettings(guildId); 
    const patchedPrefixes = patch.prefixes 
      ?? (typeof patch.prefix === "string" ? [patch.prefix] : current.prefixes); 
    const prefixes = normalizePrefixes(patchedPrefixes); 
    const next = { ...current, ...patch, guildId, prefix: prefixes[0], prefixes }; 
    const changedKeys = this.getChangedSettingsKeys(current, next, patch);
    await this.store.setGuildSettings(next); 
    await this.recordSettingsAuditLogs(guildId, current, next, changedKeys);
    const player = this.players.get(guildId); 
    if (player) { 
      player.autoplayEnabled = next.autoplay; 
      player.voteSkipEnabled = next.voteSkipEnabled;
      player.removeAfterPlayed = next.removeAfterPlayed;
      player.permissionMode = next.permissionMode;
    } 
    return next; 
  } 

  private getChangedSettingsKeys(
    current: GuildSettings,
    next: GuildSettings,
    patch: Partial<GuildSettings>
  ) {
    const patchKeys = new Set(Object.keys(patch) as Array<keyof GuildSettings>);
    if (patchKeys.has("prefix") || patchKeys.has("prefixes")) {
      patchKeys.add("prefixes");
      patchKeys.delete("prefix");
    }

    return [...patchKeys]
      .filter((key) => key !== "guildId")
      .filter((key) => !isSameSettingValue(current[key], next[key]));
  }

  private async recordSettingsAuditLogs(
    guildId: string,
    current: GuildSettings,
    next: GuildSettings,
    keys: Array<keyof GuildSettings>
  ) {
    if (!keys.length) {
      return;
    }

    const createdAt = new Date().toISOString();
    await this.store.addSettingsAuditLogs(guildId, keys.map((key) => ({
      id: randomUUID(),
      guildId,
      settingKey: String(key),
      action: `${formatSettingName(String(key))} changed`,
      oldValue: formatSettingValue(String(key), current[key]),
      newValue: formatSettingValue(String(key), next[key]),
      createdAt
    })));
  }

  async setPrefixes(guildId: string, prefixes: string[]) {
    return this.updateGuildSettings(guildId, { prefixes });
  }

  async addPrefix(guildId: string, prefix: string) {
    const current = this.getPrefixes(guildId);
    return this.setPrefixes(guildId, [...current, prefix]);
  }

  async removePrefix(guildId: string, prefix: string) {
    const target = normalizePrefixValue(prefix);
    const next = this.getPrefixes(guildId).filter((entry) => entry !== target);
    if (next.length === this.getPrefixes(guildId).length) {
      throw new Error(`Prefix \`${target}\` is not configured for this server.`);
    }

    if (!next.length) {
      throw new Error("A server must keep at least one prefix.");
    }

    return this.setPrefixes(guildId, next);
  }

  getChannelSettings(guildId: string, channelId: string): Required<ChannelSettings> {
    const settings = this.getGuildSettings(guildId);
    const override = settings.channelSettings[channelId];
    return {
      commandsEnabled: override?.commandsEnabled ?? true,
      botMessagesEnabled: override?.botMessagesEnabled ?? true
    };
  }

  getVoiceChannelHistory(guildId: string, limit = 20) {
    return this.store.getVoiceChannelHistory(guildId).slice(0, limit);
  }

  getSongHistory(guildId: string, days = 14): PlaybackHistoryEntry[] {
    return this.store.getSongHistory(guildId, days);
  }

  async recordVoiceStateChange(oldState: VoiceState, newState: VoiceState) { 
    if (newState.id === this.client.user?.id) {
      await this.recordBotVoiceStateChange(newState);
    }

    if (oldState.channelId === newState.channelId) { 
      return; 
    } 

    const guild = newState.guild ?? oldState.guild;
    const member = newState.member ?? oldState.member;
    const action: VoiceChannelHistoryEntry["action"] = !oldState.channelId
      ? "joined"
      : !newState.channelId
        ? "left"
        : "moved";

    await this.store.addVoiceChannelHistory({
      id: randomUUID(),
      guildId: guild.id,
      memberId: member?.id ?? newState.id,
      memberName: member?.displayName ?? member?.user.username ?? newState.id,
      action,
      fromChannelId: oldState.channelId ?? undefined,
      fromChannelName: oldState.channel?.name,
      toChannelId: newState.channelId ?? undefined,
      toChannelName: newState.channel?.name,
      createdAt: new Date().toISOString()
    });

    if (newState.id === this.client.user?.id && oldState.channelId && !newState.channelId) {
      const player = this.players.get(guild.id);
      if (player) {
        console.log(`[voice:${guild.id}] bot left voice; closing Lavalink connection`);
        await player.disconnect();
      } else {
        await this.lavalink.leave(guild.id).catch(() => undefined);
      }
      this.voteSkipVoters.delete(guild.id); 
    } 

    const player = this.players.get(guild.id);
    const snapshot = player?.snapshot();
    if (
      player
      && snapshot?.soloSessionUserId === newState.id
      && snapshot.voiceChannelId === oldState.channelId
      && newState.channelId !== oldState.channelId
    ) {
      console.log(`[voice:${guild.id}] solo session owner left voice; disabling solo session`);
      await player.clearSoloSessionForUser(newState.id);
    }
  } 

  async recordVoiceChannelUpdate(oldChannel: GuildBasedChannel, newChannel: GuildBasedChannel) {
    if (!oldChannel.isVoiceBased() || !newChannel.isVoiceBased()) {
      return;
    }

    if (oldChannel.rtcRegion === newChannel.rtcRegion) {
      return;
    }

    const player = this.players.get(newChannel.guild.id);
    if (player?.snapshot().voiceChannelId !== newChannel.id) {
      return;
    }

    const reason = "voice-region";
    const timerKey = `${newChannel.guild.id}:${newChannel.id}`;
    const existingTimer = this.voiceRegionPauseTimers.get(timerKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    console.log(
      `[voice:${newChannel.guild.id}] voice region changed for active channel; temporarily pausing playback`
    );
    await player.holdTemporaryPause(reason);

    const timer = setTimeout(() => {
      this.voiceRegionPauseTimers.delete(timerKey);
      void player.releaseTemporaryPause(reason).catch((error) => {
        console.error(`[voice:${newChannel.guild.id}] failed to resume after voice region update`, error);
      });
    }, 10_000);
    timer.unref?.();
    this.voiceRegionPauseTimers.set(timerKey, timer);
  }

  async holdPlayersForShardInterruption(shardId: number) {
    const reason = "discord-connection";
    await Promise.all([...this.players.values()]
      .filter((player) => player.snapshot().current && this.client.guilds.cache.get(player.snapshot().guildId)?.shardId === shardId)
      .map((player) => player.holdTemporaryPause(reason)));
  }

  async releasePlayersForShardInterruption(shardId: number) {
    const reason = "discord-connection";
    await Promise.all([...this.players.values()]
      .filter((player) => this.client.guilds.cache.get(player.snapshot().guildId)?.shardId === shardId)
      .map((player) => player.releaseTemporaryPause(reason)));
  }

  private async recordBotVoiceStateChange(state: VoiceState) {
    const player = this.players.get(state.guild.id);
    if (!player) {
      return;
    }

    const muted = Boolean(state.channelId && (state.serverMute || state.selfMute || state.suppress));
    if (muted) {
      console.log(`[voice:${state.guild.id}] bot is muted or suppressed; temporarily pausing playback`);
      await player.holdTemporaryPause("bot-muted");
      return;
    }

    await player.releaseTemporaryPause("bot-muted");
  }

  listAuditLogs(guildId: string, limit = 20): DashboardAuditLogEntry[] { 
    return this.store.getSettingsAuditLogs(guildId).slice(0, Math.max(1, Math.min(100, limit))); 
  } 
  canSendBotMessages(guildId: string, channelId: string) {
    return this.getChannelSettings(guildId, channelId).botMessagesEnabled;
  }

  async setChannelCommandsEnabled(guildId: string, channelId: string, enabled: boolean) {
    const settings = this.getGuildSettings(guildId);
    const channelSettings = { ...settings.channelSettings };
    const next: ChannelSettings = {
      ...(channelSettings[channelId] ?? {}),
      commandsEnabled: enabled
    };

    if (next.commandsEnabled !== false && next.botMessagesEnabled !== false) {
      delete channelSettings[channelId];
    } else {
      channelSettings[channelId] = next;
    }

    return this.updateGuildSettings(guildId, { channelSettings });
  }

  async setChannelBotMessagesEnabled(guildId: string, channelId: string, enabled: boolean) {
    const settings = this.getGuildSettings(guildId);
    const channelSettings = { ...settings.channelSettings };
    const next: ChannelSettings = {
      ...(channelSettings[channelId] ?? {}),
      botMessagesEnabled: enabled
    };

    if (next.commandsEnabled !== false && next.botMessagesEnabled !== false) {
      delete channelSettings[channelId];
    } else {
      channelSettings[channelId] = next;
    }

    const updated = await this.updateGuildSettings(guildId, { channelSettings });
    if (!enabled) {
      await this.players.get(guildId)?.clearAnnouncements(channelId);
    }
    return updated;
  }

  async setCommandEnabled(guildId: string, commandName: string, enabled: boolean) {
    const settings = this.getGuildSettings(guildId);
    let normalizedName = commandName.toLowerCase();
    if (normalizedName === "playlist") {
      normalizedName = "shock-list";
    }

    const disabledCommands = new Set(settings.disabledCommands.map((entry) => entry.toLowerCase()));

    if (enabled) {
      disabledCommands.delete(normalizedName);
      if (normalizedName === "shock-list") {
        disabledCommands.delete("playlist");
      }
    } else {
      disabledCommands.add(normalizedName);
    }

    return this.updateGuildSettings(guildId, {
      disabledCommands: [...disabledCommands].sort((left, right) => left.localeCompare(right))
    });
  }

  async setMemberPermissionOverride(guildId: string, memberId: string, override?: MemberPermissionOverride) {
    const settings = this.getGuildSettings(guildId);
    const memberPermissions = { ...settings.memberPermissions };
    if (override) {
      memberPermissions[memberId] = override;
    } else {
      delete memberPermissions[memberId];
    }

    return this.updateGuildSettings(guildId, { memberPermissions });
  }

  async play(interaction: ChatInputCommandInteraction, query: string) {
    const normalizedQuery = this.normalizePlayableInput(query);
    const guild = interaction.guild;
    if (!guild) {
      throw new Error("This command can only be used in a server.");
    }

    const member = await guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;

    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error("Join a voice channel first.");
    }

    await this.assertCanControl(member, guild.id);

    const player = await this.ensurePlayer(guild, voiceChannel, interaction.channelId);
    const playlistResult = await this.resolvePlaylistLink(
      normalizedQuery,
      guild.id,
      interaction.user.username,
      interaction.user.id,
      player.snapshot().upcoming.length
    );
    if (playlistResult) {
      await player.enqueueMany(playlistResult.tracks);
      return playlistResult;
    }

    const track = await this.resolver.resolve({
      query: normalizedQuery,
      requestedBy: interaction.user.username,
      requestedById: interaction.user.id
    });
    this.assertTrackWithinLimit(guild.id, track);

    await player.enqueue(track);
    return { tracks: [track] };
  }

  async insert(interaction: ChatInputCommandInteraction, query: string) {
    const normalizedQuery = this.normalizePlayableInput(query);
    const guild = interaction.guild;
    if (!guild) {
      throw new Error("This command can only be used in a server.");
    }

    const member = await guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;

    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error("Join a voice channel first.");
    }

    await this.assertCanControl(member, guild.id);

    const player = await this.ensurePlayer(guild, voiceChannel, interaction.channelId);
    if (this.isPlaylistUrl(normalizedQuery)) {
      throw new Error("Use `play` for multi-track links (e.g. Spotify or YouTube lists). `insert` only supports one track at a time.");
    }

    const track = await this.resolver.resolve({
      query: normalizedQuery,
      requestedBy: interaction.user.username,
      requestedById: interaction.user.id
    });
    this.assertTrackWithinLimit(guild.id, track);

    await player.enqueue(track, 0);
    return track;
  }

  async join(interaction: ChatInputCommandInteraction) {
    const guild = interaction.guild;
    if (!guild) {
      throw new Error("This command can only be used in a server.");
    }

    const member = await guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;

    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error("Join a voice channel first.");
    }

    await this.assertCanControl(member, guild.id);
    await this.ensurePlayer(guild, voiceChannel, interaction.channelId);
    return voiceChannel;
  }

  async joinFromMessage(message: Message) {
    const guild = message.guild;
    if (!guild) {
      throw new Error("This command can only be used in a server.");
    }

    const member = await guild.members.fetch(message.author.id);
    const voiceChannel = member.voice.channel;

    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error("Join a voice channel first.");
    }

    await this.assertCanControl(member, guild.id);
    await this.ensurePlayer(guild, voiceChannel, message.channelId);
    return voiceChannel;
  }

  async playMany(interaction: ChatInputCommandInteraction, queries: string[]) {
    const tracks: ResolvedTrack[] = [];
    for (const query of queries) {
      tracks.push(...(await this.play(interaction, query)).tracks);
    }
    return tracks;
  }

  async playFromMessage(message: Message, query: string): Promise<PlayResult> {
    const normalizedQuery = this.normalizePlayableInput(query);
    const guild = message.guild;
    if (!guild) {
      throw new Error("This command can only be used in a server.");
    }

    const member = await guild.members.fetch(message.author.id);
    const voiceChannel = member.voice.channel;

    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error("Join a voice channel first.");
    }

    await this.assertCanControl(member, guild.id);

    const player = await this.ensurePlayer(guild, voiceChannel, message.channelId);
    const playlistResult = await this.resolvePlaylistLink(
      normalizedQuery,
      guild.id,
      message.author.username,
      message.author.id,
      player.snapshot().upcoming.length
    );
    if (playlistResult) {
      await player.enqueueMany(playlistResult.tracks);
      return playlistResult;
    }

    const track = await this.resolver.resolve({
      query: normalizedQuery,
      requestedBy: message.author.username,
      requestedById: message.author.id
    });
    this.assertTrackWithinLimit(guild.id, track);

    await player.enqueue(track);
    return { tracks: [track] };
  }

  async playFromSearchSelection(interaction: StringSelectMenuInteraction, query: string): Promise<PlayResult> {
    const normalizedQuery = this.normalizePlayableInput(query);
    const guild = interaction.guild;
    if (!guild) {
      throw new Error("This command can only be used in a server.");
    }

    const member = await guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;

    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error("Join a voice channel first.");
    }

    await this.assertCanControl(member, guild.id);

    const player = await this.ensurePlayer(guild, voiceChannel, interaction.channelId);
    const track = await this.resolver.resolve({
      query: normalizedQuery,
      requestedBy: interaction.user.username,
      requestedById: interaction.user.id
    });
    this.assertTrackWithinLimit(guild.id, track);

    await player.enqueue(track);
    return { tracks: [track] };
  }

  async insertFromMessage(message: Message, query: string) {
    const normalizedQuery = this.normalizePlayableInput(query);
    const guild = message.guild;
    if (!guild) {
      throw new Error("This command can only be used in a server.");
    }

    const member = await guild.members.fetch(message.author.id);
    const voiceChannel = member.voice.channel;

    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error("Join a voice channel first.");
    }

    await this.assertCanControl(member, guild.id);

    const player = await this.ensurePlayer(guild, voiceChannel, message.channelId);
    if (this.isPlaylistUrl(normalizedQuery)) {
      throw new Error("Use `play` for multi-track links (e.g. Spotify or YouTube lists). `insert` only supports one track at a time.");
    }

    const track = await this.resolver.resolve({
      query: normalizedQuery,
      requestedBy: message.author.username,
      requestedById: message.author.id
    });
    this.assertTrackWithinLimit(guild.id, track);

    await player.enqueue(track, 0);
    return track;
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const candidateLimit = Math.min(
      Math.max(limit * searchCandidateMultiplier, limit),
      maxSearchValidationCandidates
    );
    const candidates = await this.resolver.search(query, candidateLimit);
    return this.filterPlayableSearchResults(candidates, limit);
  }

  private async filterPlayableSearchResults(results: SearchResult[], limit: number): Promise<SearchResult[]> {
    if (!this.lavalink.enabled || !results.length || limit < 1) {
      return [];
    }

    const seenUrls = new Set<string>();
    const uniqueResults = results.filter((result) => {
      const key = result.url.toLowerCase();
      if (seenUrls.has(key)) {
        return false;
      }

      seenUrls.add(key);
      return true;
    });
    const playableResults: SearchResult[] = [];

    for (let index = 0; index < uniqueResults.length && playableResults.length < limit; index += searchValidationConcurrency) {
      const batch = uniqueResults.slice(index, index + searchValidationConcurrency);
      const checks = await Promise.all(batch.map((result) => this.canLavalinkResolveSearchResult(result)));

      checks.forEach((isPlayable, batchIndex) => {
        if (isPlayable) {
          playableResults.push(batch[batchIndex]);
        }
      });
    }

    return playableResults.slice(0, limit);
  }

  private async canLavalinkResolveSearchResult(result: SearchResult) {
    try {
      await this.withSearchValidationTimeout(this.lavalink.resolve(result.url));
      return true;
    } catch {
      return false;
    }
  }

  private withSearchValidationTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out while checking whether Lavalink can play a search result."));
      }, searchValidationTimeoutMs);
      timeout.unref?.();

      promise.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        }
      );
    });
  }

  private async resolvePlaylistLink(
    query: string,
    guildId: string,
    requestedBy: string,
    requestedById: string,
    currentQueueLength: number
  ): Promise<PlayResult | null> {
    const normalizedQuery = await this.normalizePlayableUrlForResolution(query);
    if (!this.isPlaylistUrl(normalizedQuery)) {
      return null;
    }

    const loadLimit = this.getExternalPlaylistLoadLimit(guildId, currentQueueLength);
    if (loadLimit < 1) {
      throw new Error(`Queue limit reached (${appConfig.maxQueueSize} tracks).`);
    }

    if (this.isSpotifyPlaylistUrl(normalizedQuery)) {
      const playlist = await this.resolver.resolveSpotifyPlaylist({
        url: normalizedQuery,
        requestedBy,
        requestedById,
        maxTracks: loadLimit
      });
      return {
        tracks: playlist.tracks,
        playlistName: playlist.name,
        playlistTotalTracks: playlist.totalTracks
      };
    }

    if (this.isSpotifyAlbumUrl(normalizedQuery)) {
      const album = await this.resolver.resolveSpotifyAlbum({
        url: normalizedQuery,
        requestedBy,
        requestedById,
        maxTracks: loadLimit
      });
      return {
        tracks: album.tracks,
        playlistName: album.name,
        playlistTotalTracks: album.totalTracks
      };
    }

    if (!this.isLavalinkSupportedPlaylistUrl(normalizedQuery)) {
      throw new Error(
        "That playlist provider is not configured for playlist expansion yet. Spotify albums/playlists, Apple Music, YouTube playlists, and SoundCloud sets can be queued with `/play query` right now."
      );
    }

    const playlist = await this.lavalink.resolvePlaylist(normalizedQuery);
    const playlistTracks = playlist.tracks.slice(0, loadLimit);
    this.assertPlaylistWithinLimit(guildId, playlistTracks.length);

    const tracks = playlistTracks.map((track) => {
      const durationInSeconds = Math.floor(track.info.length / 1000) || undefined;
      const sourceUrl = track.info.uri ?? normalizedQuery;
      const sourceProvider = this.resolver.detectProvider(sourceUrl);
      const resolved: ResolvedTrack = {
        id: randomUUID(),
        title: track.info.title || "Unknown title",
        artist: track.info.author,
        url: sourceUrl,
        artwork: "artworkUrl" in track.info ? track.info.artworkUrl : undefined,
        durationInSeconds,
        requestedBy,
        requestedById,
        sourceProvider,
        playbackProvider: sourceProvider === "soundcloud" || sourceProvider === "spotify" ? sourceProvider : "youtube", 
        playbackUrl: sourceUrl,
        encodedTrack: track.encoded,
        addedAt: new Date().toISOString()
      };
      this.assertTrackWithinLimit(guildId, resolved, `The queued playlist track **${resolved.title}**`);
      return resolved;
    });

    return { tracks, playlistName: playlist.name, playlistTotalTracks: playlist.tracks.length };
  }

  private isPlaylistUrl(query: string) {
    const url = this.parseHttpUrl(query);
    if (!url) {
      return false;
    }

    const host = url.hostname.toLowerCase();
    return (
      (host.includes("youtube.com") && url.searchParams.has("list"))
      || (host === "youtu.be" && url.searchParams.has("list"))
      || (host.includes("soundcloud.com") && /\/sets\//i.test(url.pathname))
      || (host.includes("spotify.com") && /\/(?:album|playlist)\//i.test(url.pathname))
      || (host.includes("deezer.com") && /\/playlist\//i.test(url.pathname))
      || (host.includes("music.apple.com") && /\/playlist\//i.test(url.pathname))
      || (host.includes("music.amazon.") && /\/playlists\//i.test(url.pathname))
    );
  }

  private isSpotifyPlaylistUrl(query: string) {
    const url = this.parseHttpUrl(query);
    if (!url) {
      return false;
    }

    return url.hostname.toLowerCase().includes("spotify.com") && /\/playlist\//i.test(url.pathname);
  }

  private isSpotifyAlbumUrl(query: string) {
    const url = this.parseHttpUrl(query);
    if (!url) {
      return false;
    }

    return url.hostname.toLowerCase().includes("spotify.com") && /\/album\//i.test(url.pathname);
  }

  private isLavalinkSupportedPlaylistUrl(query: string) {
    const url = this.parseHttpUrl(query);
    if (!url) {
      return false;
    }

    const host = url.hostname.toLowerCase();
    return (
      (host.includes("youtube.com") && url.searchParams.has("list"))
      || (host === "youtu.be" && url.searchParams.has("list"))
      || (host.includes("soundcloud.com") && /\/sets\//i.test(url.pathname))
      || (host.includes("music.apple.com") && /\/playlist\//i.test(url.pathname))
    );
  }

  private parseHttpUrl(query: string) {
    const normalizedQuery = this.normalizePlayableInput(query);
    if (!/^https?:\/\//i.test(normalizedQuery)) {
      return undefined;
    }

    try {
      return new URL(normalizedQuery);
    } catch {
      return undefined;
    }
  }

  private normalizePlayableInput(query: string) {
    const trimmed = query.trim();
    const bracketedUrl = trimmed.match(/^<\s*(https?:\/\/[^>]+)\s*>$/i)?.[1];
    return bracketedUrl ?? trimmed;
  }

  private async normalizePlayableUrlForResolution(query: string) {
    const normalized = this.normalizePlayableInput(query);
    const parsed = this.parseHttpUrl(normalized);
    if (!parsed || !this.isSpotifyShortHost(parsed.hostname)) {
      return normalized;
    }

    try {
      const response = await fetch(parsed.toString(), {
        redirect: "follow",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "DroTunesBot/0.1 (+playlist resolver)"
        }
      });
      return response.url || normalized;
    } catch {
      return normalized;
    }
  }

  private isSpotifyShortHost(hostname: string) {
    const host = hostname.toLowerCase();
    return host === "spoti.fi" || host === "spotify.link" || host.endsWith(".spotify.link");
  }

  private getExternalPlaylistLoadLimit(guildId: string, currentQueueLength: number) {
    const queueRoom = Math.max(0, appConfig.maxQueueSize - currentQueueLength);
    const guildLimit = this.getGuildSettings(guildId).maxPlaylistLength ?? appConfig.maxQueueSize;
    return Math.min(queueRoom, guildLimit, appConfig.maxQueueSize);
  }

  async pause(guildId: string) {
    await this.getPlayerOrThrow(guildId).pause();
  }

  async resume(guildId: string) {
    await this.getPlayerOrThrow(guildId).resume();
  }

  async stop(guildId: string) {
    await this.getPlayerOrThrow(guildId).stop();
    this.voteSkipVoters.delete(guildId);
  }

  async disconnect(guildId: string) {
    await this.getPlayerOrThrow(guildId).disconnect();
    this.voteSkipVoters.delete(guildId);
  }

  async skip(guildId: string) {
    await this.getPlayerOrThrow(guildId).skip();
    this.voteSkipVoters.delete(guildId);
  }

  async skipTo(guildId: string, index: number) {
    await this.getPlayerOrThrow(guildId).skipTo(index);
    this.voteSkipVoters.delete(guildId);
  }

  async playPrevious(guildId: string) {
    await this.getPlayerOrThrow(guildId).playPrevious();
  }

  async restartCurrent(guildId: string) {
    const player = this.getPlayerOrThrow(guildId);
    const current = player.snapshot().current;
    if (!current) {
      throw new Error("Nothing is playing right now.");
    }

    await player.seekTo(0);
    return current;
  }

  async setVolume(guildId: string, percent: number) {
    await this.getPlayerOrThrow(guildId).setVolume(percent);
  }

  async setFilterPreset(guildId: string, preset: FilterPreset) {
    return this.getPlayerOrThrow(guildId).setFilterPreset(preset);
  }

  async remove(guildId: string, index: number) {
    return this.getPlayerOrThrow(guildId).remove(index);
  }

  async removeByUser(guildId: string, userId: string) {
    return this.getPlayerOrThrow(guildId).removeTracksByRequester(userId);
  }

  async move(guildId: string, from: number, to: number) {
    return this.getPlayerOrThrow(guildId).move(from, to);
  }

  async removeLast(guildId: string) {
    return this.getPlayerOrThrow(guildId).removeLast();
  }

  async removeDuplicates(guildId: string) {
    return this.getPlayerOrThrow(guildId).removeDuplicates();
  }

  async removeAbsent(guildId: string) {
    const player = this.getPlayerOrThrow(guildId);
    const channelId = player.snapshot().voiceChannelId;
    if (!channelId) {
      throw new Error("The bot is not connected to a voice channel.");
    }

    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    if (!channel || !("members" in channel)) {
      throw new Error("Unable to read the current voice channel.");
    }

    if (!("filter" in channel.members)) {
      throw new Error("Unable to inspect the current voice channel members.");
    }

    const activeMemberIds = new Set(channel.members.filter(() => true).map((member) => member.id));
    return player.removeAbsentMembers(activeMemberIds);
  }

  async massRemove(guildId: string, start: number, count: number) {
    return this.getPlayerOrThrow(guildId).massRemove(start, count);
  }

  async clearQueue(guildId: string) {
    return this.getPlayerOrThrow(guildId).clearQueue();
  }

  async autoFix(guildId: string) {
    const player = this.players.get(guildId);
    if (!player) {
      return {
        applied: false,
        actions: ["No active player was found for this guild. Use /join or /play to start a fresh voice session."]
      };
    }

    return player.autoFix();
  }

  async seekRelative(guildId: string, deltaSeconds: number) {
    const player = this.getPlayerOrThrow(guildId);
    const target = player.getCurrentPositionSeconds() + deltaSeconds;
    await player.seekTo(target);
    return player.getCurrentPositionSeconds();
  }

  async toggleVoteSkip(guildId: string, enabled?: boolean) {
    const settings = await this.updateGuildSettings(guildId, {
      voteSkipEnabled: enabled ?? !this.getGuildSettings(guildId).voteSkipEnabled
    });
    return settings.voteSkipEnabled;
  }

  async toggleRemoveAfterPlayed(guildId: string, enabled?: boolean) {
    const settings = await this.updateGuildSettings(guildId, {
      removeAfterPlayed: enabled ?? !this.getGuildSettings(guildId).removeAfterPlayed
    });
    return settings.removeAfterPlayed;
  }

  async setStayInVoiceForPremium(member: GuildMember, textChannelId: string, enabled: boolean) {
    this.assertPremiumUser(member.id);

    if (enabled) {
      const voiceChannel = member.voice.channel;
      if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
        throw new Error("Join a voice channel first.");
      }

      await this.assertCanControl(member, member.guild.id);
      const player = await this.ensurePlayer(member.guild, voiceChannel, textChannelId);
      return player.setStayInVoice(true, member.id);
    }

    const player = this.getPlayerOrThrow(member.guild.id);
    return player.setStayInVoice(false);
  }

  async setSoloSessionForPremium(member: GuildMember, textChannelId: string, enabled: boolean) {
    this.assertPremiumSoloUser(member.id);

    const voiceChannel = member.voice.channel;
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error("Join a voice channel first.");
    }

    await this.assertCanControl(member, member.guild.id);
    const player = await this.ensurePlayer(member.guild, voiceChannel, textChannelId);
    if (player.snapshot().voiceChannelId !== voiceChannel.id) {
      throw new Error("Join the bot's current voice channel to change solo session.");
    }

    return player.setSoloSession(enabled, member.id);
  }

  async handleVoteSkip(interaction: ChatInputCommandInteraction) {
    const guild = interaction.guild;
    const guildId = interaction.guildId;
    if (!guild || !guildId) {
      throw new Error("This command must be used in a server.");
    }

    const member = await guild.members.fetch(interaction.user.id);
    await this.assertCanControl(member, guildId);

    const settings = this.getGuildSettings(guildId);
    if (!settings.voteSkipEnabled) {
      await this.skip(guildId);
      return { skipped: true, needed: 0, votes: 0 };
    }

    const player = this.getPlayerOrThrow(guildId);
    const channelId = player.snapshot().voiceChannelId;
    if (!channelId) {
      throw new Error("The bot is not connected to a voice channel.");
    }

    if (member.voice.channelId !== channelId) {
      throw new Error("Join the bot's voice channel to vote skip.");
    }

    const channel = await guild.channels.fetch(channelId);
    if (!channel || !("members" in channel)) {
      throw new Error("Unable to inspect the voice channel for vote skip.");
    }

    if (!("filter" in channel.members)) {
      throw new Error("Unable to inspect the voice channel for vote skip.");
    }

    const listeners = channel.members.filter((entry) => !entry.user.bot);
    const needed = Math.max(1, Math.ceil(listeners.size / 2));
    const voters = this.voteSkipVoters.get(guildId) ?? new Set<string>();
    voters.add(interaction.user.id);
    this.voteSkipVoters.set(guildId, voters);

    if (voters.size >= needed) {
      await this.skip(guildId);
      return { skipped: true, needed, votes: voters.size };
    }

    return { skipped: false, needed, votes: voters.size };
  }

  async createOrReplacePlaylist(guildId: string, name: string, createdById: string) { 
    const snapshot = this.getSnapshot(guildId); 
    const tracks = [snapshot.current, ...snapshot.upcoming].filter(Boolean) as ResolvedTrack[]; 
    this.assertPlaylistWithinLimit(guildId, tracks.length); 
    const playlist: Playlist = {
      name,
      createdById,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tracks
    };
    await this.store.setPlaylist(playlist);
    return playlist;
  }

  async addCurrentToPlaylist(guildId: string, name: string, createdById: string) { 
    const snapshot = this.getSnapshot(guildId);
    if (!snapshot.current) {
      throw new Error("Nothing is playing right now.");
    }

    const existing = this.store.getPlaylist(createdById, name); 
    const playlist: Playlist = existing ?? {
      name,
      createdById,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tracks: []
    };

    this.assertPlaylistWithinLimit(guildId, playlist.tracks.length + 1);
    playlist.tracks.push(snapshot.current);
    playlist.updatedAt = new Date().toISOString();
    await this.store.setPlaylist(playlist);
    return playlist; 
  } 

  async addTrackLinkToPlaylist(guildId: string, ownerId: string, ownerName: string, name: string, query: string) { 
    const normalizedQuery = this.normalizePlayableInput(query); 
    if (this.isPlaylistUrl(normalizedQuery)) { 
      throw new Error("That looks like a playlist link. Use `addplaylist` for multi-track links."); 
    } 

    const playlist = this.getOrCreatePlaylist(ownerId, name);  
    const track = await this.resolver.resolve({ 
      query: normalizedQuery, 
      requestedBy: ownerName, 
      requestedById: ownerId 
    }); 
    this.assertTrackWithinLimit(guildId, track, `The shock-list track **${track.title}**`); 
    this.assertPlaylistWithinLimit(guildId, playlist.tracks.length + 1); 
    playlist.tracks.push(track); 
    playlist.updatedAt = new Date().toISOString(); 
    await this.store.setPlaylist(playlist); 
    return { playlist, addedCount: 1 }; 
  } 

  async addPlaylistLinkToPlaylist(guildId: string, ownerId: string, ownerName: string, name: string, query: string) { 
    const playlist = this.getOrCreatePlaylist(ownerId, name);  
    const result = await this.resolvePlaylistLink( 
      this.normalizePlayableInput(query), 
      guildId, 
      ownerName, 
      ownerId, 
      playlist.tracks.length 
    ); 
    if (!result) { 
      throw new Error("That does not look like a supported playlist link."); 
    } 

    this.assertPlaylistWithinLimit(guildId, playlist.tracks.length + result.tracks.length); 
    playlist.tracks.push(...result.tracks); 
    playlist.updatedAt = new Date().toISOString(); 
    await this.store.setPlaylist(playlist); 
    return { playlist, addedCount: result.tracks.length, playlistName: result.playlistName, playlistTotalTracks: result.playlistTotalTracks }; 
  } 

  async removeTrackFromPlaylist(guildId: string, ownerId: string, name: string, oneBasedIndex: number) { 
    const playlist = this.store.getPlaylist(ownerId, name); 
    if (!playlist) { 
      throw new Error("That shock-list does not exist."); 
    } 

    if (!Number.isInteger(oneBasedIndex) || oneBasedIndex < 1 || oneBasedIndex > playlist.tracks.length) { 
      throw new Error(`Pick a song number from 1 to ${playlist.tracks.length}.`); 
    } 

    const [removed] = playlist.tracks.splice(oneBasedIndex - 1, 1); 
    playlist.updatedAt = new Date().toISOString(); 
    await this.store.setPlaylist(playlist); 
    return removed; 
  } 

  async loadPlaylist(interaction: ChatInputCommandInteraction, name: string, ownerId = interaction.user.id) { 
    const guildId = interaction.guildId;
    if (!guildId) {
      throw new Error("This command must be used in a server.");
    }

    const playlist = this.store.getPlaylist(ownerId, name); 
    if (!playlist) {
      throw new Error("That shock-list does not exist.");
    }
    this.assertPlaylistWithinLimit(guildId, playlist.tracks.length);
    for (const track of playlist.tracks) {
      this.assertTrackWithinLimit(guildId, track, `The shock-list track **${track.title}**`);
    }

    const guild = interaction.guild;
    if (!guild) {
      throw new Error("This command must be used in a server.");
    }

    const member = await guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error("Join a voice channel first.");
    }

    await this.assertCanControl(member, guildId);
    const player = await this.ensurePlayer(guild, voiceChannel, interaction.channelId);
    await player.enqueueMany(playlist.tracks.map((track) => ({
      ...track,
      id: `${track.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      addedAt: new Date().toISOString(),
      requestedBy: interaction.user.username,
      requestedById: interaction.user.id
    })));

    return playlist.tracks.length;
  }

  async loadPlaylistFromMessage(message: Message, name: string, ownerId = message.author.id) { 
    const guild = message.guild;
    if (!guild) {
      throw new Error("This command must be used in a server.");
    }

    const playlist = this.store.getPlaylist(ownerId, name); 
    if (!playlist) {
      throw new Error("That shock-list does not exist.");
    }

    this.assertPlaylistWithinLimit(guild.id, playlist.tracks.length);
    for (const track of playlist.tracks) {
      this.assertTrackWithinLimit(guild.id, track, `The shock-list track **${track.title}**`);
    }

    const member = await guild.members.fetch(message.author.id);
    const voiceChannel = member.voice.channel;
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error("Join a voice channel first.");
    }

    await this.assertCanControl(member, guild.id);
    const player = await this.ensurePlayer(guild, voiceChannel, message.channelId);
    await player.enqueueMany(playlist.tracks.map((track) => ({
      ...track,
      id: `${track.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      addedAt: new Date().toISOString(),
      requestedBy: message.author.username,
      requestedById: message.author.id
    })));

    return playlist.tracks.length;
  }

  listPlaylists(ownerId: string) {  
    return this.store.getPlaylists(ownerId);  
  }  
 
  listAllPlaylists() {  
    return this.store.getAllPlaylists();  
  }  
 
  getPlaylist(ownerId: string, name: string) {  
    return this.store.getPlaylist(ownerId, name);  
  }  
 
  async deletePlaylist(ownerId: string, name: string) {  
    await this.store.deletePlaylist(ownerId, name);  
  }  
 
  private getOrCreatePlaylist(ownerId: string, name: string): Playlist {  
    return this.store.getPlaylist(ownerId, name) ?? {  
      name, 
      createdById: ownerId, 
      createdAt: new Date().toISOString(), 
      updatedAt: new Date().toISOString(), 
      tracks: [] 
    }; 
  } 

  getCurrentTrack(guildId: string) { 
    return this.getSnapshot(guildId).current;
  }

  getSnapshot(guildId: string): QueueSnapshot {
    const player = this.players.get(guildId);
    if (player) {
      return this.enrichDashboardSnapshot(player.snapshot());
    }

    const settings = this.getGuildSettings(guildId);
    const persisted = this.store.getGuildPlayer(guildId);
    const hasSessionState = Boolean(
      persisted?.voiceChannelId
      || persisted?.current
      || persisted?.queue.length
    );
    const snapshot: QueueSnapshot = {
      guildId,
      guildName: persisted?.guildName ?? this.client.guilds.cache.get(guildId)?.name ?? guildId,
      voiceChannelId: persisted?.voiceChannelId,
      textChannelId: persisted?.textChannelId,
      sessionId: persisted?.sessionId,
      sessionStartedAt: persisted?.sessionStartedAt,
      stayInVoiceEnabled: persisted?.stayInVoiceEnabled ?? false,
      stayInVoiceById: persisted?.stayInVoiceById,
      soloSessionUserId: persisted?.soloSessionUserId,
      isPlaying: false,
      isPaused: false,
      volume: persisted?.volume ?? 75,
      filterPreset: persisted?.filterPreset ?? "off",
      autoplay: settings.autoplay,
      voteSkipEnabled: settings.voteSkipEnabled,
      removeAfterPlayed: settings.removeAfterPlayed,
      permissionMode: settings.permissionMode,
      current: persisted?.current,
      previous: hasSessionState ? persisted?.history.at(-1) : undefined,
      played: hasSessionState ? persisted?.history ?? [] : [],
      upcoming: persisted?.queue ?? []
    };

    return this.enrichDashboardSnapshot(snapshot);
  }

  listSnapshots(): QueueSnapshot[] {
    const live = new Set(this.players.keys());
    const snapshots = [...this.players.values()].map((player) => this.enrichDashboardSnapshot(player.snapshot()));

    for (const guildId of this.client.guilds.cache.keys()) {
      if (!live.has(guildId)) {
        snapshots.push(this.getSnapshot(guildId));
      }
    }

    return snapshots;
  }

  isBotOwnerId(userId: string) {
    return appConfig.botOwners.includes(userId);
  }

  isBotManagerId(userId: string) {
    return appConfig.botManagers.includes(userId);
  }

  hasBotManagementAccess(userId: string) { 
    return this.isBotOwnerId(userId) || this.isBotManagerId(userId); 
  } 
 
  isGloballyDeniedUser(userId: string) { 
    return this.store.getGlobalDeniedUserIds().includes(userId); 
  } 
 
  getGlobalDeniedUserIds() { 
    return this.store.getGlobalDeniedUserIds(); 
  } 
 
  async denyBotAccessGlobally(userId: string) { 
    if (this.hasBotManagementAccess(userId)) { 
      throw new Error("Configured bot owners or bot managers cannot be globally denied bot access."); 
    } 
 
    await this.store.setGlobalDeniedUserIds([...this.store.getGlobalDeniedUserIds(), userId]); 
  } 
 
  async assertBotOwner(member: GuildMember) { 
    if (this.hasBotManagementAccess(member.id)) {
      return;
    }

    throw new Error("Only configured bot owners or bot managers can use that command.");
  }

  async assertCanControl(member: GuildMember, guildId: string) { 
    if (this.isGloballyDeniedUser(member.id)) { 
      throw new Error("You are not allowed to use this bot."); 
    } 

    this.assertSoloSessionAccess(member, guildId);
 
    const settings = this.getGuildSettings(guildId); 
    if (this.isModerator(member)) { 
      return;
    }

    const override = settings.memberPermissions[member.id];
    if (override === "deny") {
      throw new Error("You are not allowed to control this bot in this server.");
    }

    if (override === "allow") {
      return;
    }

    if (settings.permissionMode === "everyone") {
      return;
    }

    if (settings.permissionMode === "admins") {
      if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return;
      }
      throw new Error("Only server managers can run that command here.");
    }

    if (settings.djRoleId && member.roles.cache.has(settings.djRoleId)) {
      return;
    }

    throw new Error("You need the configured DJ role to run that command.");
  }

  private assertPremiumUser(userId: string) {
    if (this.isPremiumUser(userId)) {
      return;
    }

    throw new Error("This is a premium-only feature.");
  }

  private assertPremiumSoloUser(userId: string) {
    if (this.hasPremiumSoloAccess(userId)) {
      return;
    }

    throw new Error("Solo session is a premium-only feature.");
  }

  private async resolvePlayableLavalinkTrack(
    track: ResolvedTrack
  ): Promise<Awaited<ReturnType<LavalinkService["resolve"]>>> {
    try {
      return await this.lavalink.resolve(track.playbackUrl);
    } catch (error) {
      if (track.playbackProvider !== "youtube" && track.playbackProvider !== "spotify") {
        throw error; 
      } 

      const fallbackQueries = this.buildPlaybackResolveFallbackQueries(track); 
      if (!fallbackQueries.length) {
        throw error;
      }

      console.warn( 
        `[lavalink:${track.id}] direct ${track.playbackProvider} resolve failed for "${track.title}"; trying YouTube Music search fallback`, 
        error 
      ); 

      for (const query of fallbackQueries) {
        try {
          return await this.lavalink.resolve(`ytmsearch:${query}`);
        } catch (fallbackError) {
          console.warn(`[lavalink:${track.id}] ytmsearch fallback failed for "${query}"`, fallbackError);
        }
      }

      throw error;
    }
  }

  private buildPlaybackResolveFallbackQueries(track: ResolvedTrack) {
    return [
      track.searchQuery,
      [track.artist, track.title].filter(Boolean).join(" - "),
      [track.artist, track.title].filter(Boolean).join(" "),
      [track.title, track.artist].filter(Boolean).join(" ")
    ]
      .filter((query): query is string => Boolean(query))
      .map((query) => query.trim())
      .filter((query, index, values) => Boolean(query) && values.indexOf(query) === index);
  }

  private assertSoloSessionAccess(member: GuildMember, guildId: string) {
    const soloSessionUserId = this.players.get(guildId)?.snapshot().soloSessionUserId;
    if (!soloSessionUserId || soloSessionUserId === member.id) {
      return;
    }

    throw new Error(`<@${soloSessionUserId}> has solo session enabled. Only they can control music until they leave voice or the bot disconnects.`);
  }

  async assertCanUseCommand(member: GuildMember, guildId: string, commandName: string, channelId: string) { 
    if (this.isGloballyDeniedUser(member.id)) { 
      throw new Error("You are not allowed to use this bot."); 
    } 
 
    if (this.isModerator(member)) { 
      return; 
    }

    const settings = this.getGuildSettings(guildId);
    if (settings.memberPermissions[member.id] === "deny") {
      throw new Error("You are not allowed to use this bot in this server.");
    }

    const cmd = commandName.toLowerCase();
    const disabled = new Set(settings.disabledCommands.map((entry) => entry.toLowerCase()));
    const shockListDisabled =
      disabled.has("shock-list")
      || disabled.has("playlist");
    const commandDisabled =
      disabled.has(cmd)
      || ((cmd === "shock-list" || cmd === "playlist") && shockListDisabled);

    if (commandDisabled) {
      throw new Error(`The \`${commandName}\` command is disabled in this server.`);
    }

    if (!this.getChannelSettings(guildId, channelId).commandsEnabled) {
      throw new Error("Bot commands are disabled in this channel.");
    }
  }

  async assertCanModerate(member: GuildMember) {
    if (this.isModerator(member)) {
      return;
    }

    throw new Error("You need moderator permissions to update bot settings.");
  }

  private async ensurePlayer(guild: Guild, voiceChannel: VoiceBasedChannel, textChannelId: string) {
    let player = this.players.get(guild.id);
    if (!player) {
      player = new GuildPlayer(guild, this.lavalink, {
        restoredState: this.store.getGuildPlayer(guild.id),
        canSendAnnouncements: (channelId) => this.canSendBotMessages(guild.id, channelId),
        onStateChange: async (state) => {
          if (state) {
            await this.store.setGuildPlayer(state);
          } else {
            await this.store.deleteGuildPlayer(guild.id);
          }
        },
        onPlaybackAdvanced: () => {
          this.voteSkipVoters.delete(guild.id);
        },
        onTrackRecorded: async (entry) => {
          await this.store.addSongHistory(entry);
        },
        onTrackFinished: async (track) => {
          const settings = this.getGuildSettings(guild.id);
          if (!settings.autoplay) {
            return null;
          }

          try {
            const persistedState = this.store.getGuildPlayer(guild.id);
            const recentTracks = [
              ...(persistedState?.history ?? []).slice(-8),
              ...(persistedState?.current ? [persistedState.current] : []),
              ...this.getSnapshot(guild.id).upcoming.slice(0, 8)
            ];

            const resolved = await this.resolver.resolveAutoplay({
              seedTrack: track,
              recentTracks,
              requestedBy: "Autoplay",
              requestedById: this.client.user?.id ?? "autoplay"
            });
            this.assertTrackWithinLimit(guild.id, resolved, `Autoplay picked **${resolved.title}**`);
            return resolved;
          } catch (error) {
            console.warn(`[autoplay:${guild.id}] failed to resolve a follow-up track`, error);
            return null;
          }
        },
        resolvePlaybackTrack: async (track) => {
          if (track.encodedTrack) {
            return track.encodedTrack;
          }

          const lavalinkTrack = await this.resolvePlayableLavalinkTrack(track);
          track.encodedTrack = lavalinkTrack.encoded;
          track.durationInSeconds ??= Math.floor(lavalinkTrack.info.length / 1000);
          track.playbackUrl = lavalinkTrack.info.uri ?? track.playbackUrl;
          track.title ||= lavalinkTrack.info.title;
          track.artist ||= lavalinkTrack.info.author;
          return lavalinkTrack.encoded;
        },
        resolvePlaybackRetry: async (track, failedPlaybackUrls) => {
          const retry = await this.resolver.resolvePlaybackRetry(track, failedPlaybackUrls);
          if (!retry) {
            return null;
          }

          return {
            ...track,
            title: retry.title,
            artist: retry.artist,
            artwork: retry.artwork,
            durationInSeconds: retry.durationInSeconds,
            playbackProvider: retry.playbackProvider,
            playbackUrl: retry.playbackUrl,
            encodedTrack: undefined,
            failedPlaybackUrls
          };
        }
      });
      const settings = this.getGuildSettings(guild.id);
      player.autoplayEnabled = settings.autoplay;
      player.voteSkipEnabled = settings.voteSkipEnabled;
      player.removeAfterPlayed = settings.removeAfterPlayed;
      player.permissionMode = settings.permissionMode;
      this.players.set(guild.id, player);
    }

    await player.connect(voiceChannel, textChannelId);
    return player;
  }

  private enrichDashboardSnapshot(snapshot: QueueSnapshot): QueueSnapshot {
    return {
      ...snapshot,
      voiceChannelName: snapshot.voiceChannelName ?? this.getCachedChannelName(snapshot.voiceChannelId),
      voiceChannelMemberCount: snapshot.voiceChannelMemberCount ?? this.getCachedVoiceMemberCount(snapshot.voiceChannelId),
      textChannelName: snapshot.textChannelName ?? this.getCachedChannelName(snapshot.textChannelId),
      voiceHistory: this.getVoiceChannelHistory(snapshot.guildId)
    };
  }

  private getCachedChannelName(channelId: string | undefined) {
    if (!channelId) {
      return undefined;
    }

    const channel = this.client.channels.cache.get(channelId);
    return hasName(channel) ? channel.name : undefined;
  }

  private getCachedVoiceMemberCount(channelId: string | undefined) {
    if (!channelId) {
      return undefined;
    }

    const channel = this.client.channels.cache.get(channelId);
    return hasMemberCount(channel) ? channel.members.size : undefined;
  }
  private getPlayerOrThrow(guildId: string) {
    const player = this.players.get(guildId);
    if (!player) {
      throw new Error("Nothing is playing in that server right now.");
    }

    return player;
  }

  private isModerator(member: GuildMember) {
    return this.hasBotManagementAccess(member.id) 
      || member.guild.ownerId === member.id 
      || member.permissions.has(PermissionFlagsBits.Administrator) 
      || member.permissions.has(PermissionFlagsBits.ManageGuild)
      || member.permissions.has(PermissionFlagsBits.ManageChannels);
  }

  private assertTrackWithinLimit(guildId: string, track: ResolvedTrack, label = `**${track.title}**`) {
    const maxSongLengthSeconds = this.getGuildSettings(guildId).maxSongLengthSeconds;
    if (!maxSongLengthSeconds || !track.durationInSeconds) {
      return;
    }

    if (track.durationInSeconds > maxSongLengthSeconds) {
      throw new Error(`${label} is too long for this server (${track.durationInSeconds}s > ${maxSongLengthSeconds}s).`);
    }
  }

  private assertPlaylistWithinLimit(guildId: string, trackCount: number) {
    const maxPlaylistLength = this.getGuildSettings(guildId).maxPlaylistLength;
    if (!maxPlaylistLength) {
      return;
    }

    if (trackCount > maxPlaylistLength) {
      throw new Error(`That shock-list is too large for this server (${trackCount} tracks > ${maxPlaylistLength}).`);
    }
  }
}
