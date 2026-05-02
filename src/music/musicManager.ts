import type {
  ChatInputCommandInteraction,
  Client,
  Guild,
  GuildMember,
  Message,
  VoiceBasedChannel
} from "discord.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { randomUUID } from "node:crypto";
import { appConfig } from "../config.js";
import { ProviderResolver } from "./providerResolver.js";
import { GuildPlayer } from "./guildPlayer.js";
import { LavalinkService } from "./lavalinkService.js";
import { StateStore } from "../storage/stateStore.js";
import type {
  ChannelSettings,
  FilterPreset,
  GuildSettings,
  MemberPermissionOverride,
  Playlist,
  QueueSnapshot,
  ResolvedTrack,
  SearchResult
} from "../types.js";

const defaultPrefix = "!";

export interface PlayResult {
  tracks: ResolvedTrack[];
  playlistName?: string;
  playlistTotalTracks?: number;
}

function createDefaultGuildSettings(guildId: string): GuildSettings {
  return {
    guildId,
    prefix: defaultPrefix,
    autoplay: false,
    voteSkipEnabled: false,
    preferAudioOnly: true,
    permissionMode: "everyone",
    disabledCommands: [],
    channelSettings: {},
    memberPermissions: {}
  };
}

export class MusicManager {
  private readonly resolver = new ProviderResolver();
  private readonly players = new Map<string, GuildPlayer>();
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
    return this.getGuildSettings(guildId).prefix;
  }

  getGuildSettings(guildId: string): GuildSettings {
    const stored = this.store.getGuildSettings(guildId);
    if (!stored) {
      return createDefaultGuildSettings(guildId);
    }

    const defaults = createDefaultGuildSettings(guildId);
    return {
      ...defaults,
      ...stored,
      disabledCommands: [...(stored.disabledCommands ?? [])],
      channelSettings: { ...(stored.channelSettings ?? {}) },
      memberPermissions: { ...(stored.memberPermissions ?? {}) }
    };
  }

  async updateGuildSettings(guildId: string, patch: Partial<GuildSettings>) {
    const next = { ...this.getGuildSettings(guildId), ...patch, guildId };
    await this.store.setGuildSettings(next);
    const player = this.players.get(guildId);
    if (player) {
      player.autoplayEnabled = next.autoplay;
      player.voteSkipEnabled = next.voteSkipEnabled;
      player.permissionMode = next.permissionMode;
    }
    return next;
  }

  getChannelSettings(guildId: string, channelId: string): Required<ChannelSettings> {
    const settings = this.getGuildSettings(guildId);
    const override = settings.channelSettings[channelId];
    return {
      commandsEnabled: override?.commandsEnabled ?? true,
      botMessagesEnabled: override?.botMessagesEnabled ?? true
    };
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
    const normalizedName = commandName.toLowerCase();
    const disabledCommands = new Set(settings.disabledCommands.map((entry) => entry.toLowerCase()));

    if (enabled) {
      disabledCommands.delete(normalizedName);
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
      requestedById: interaction.user.id,
      preferAudioOnly: this.shouldPreferAudioOnly(guild.id, normalizedQuery)
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
      throw new Error("Use `play` for playlists. `insert` only supports one track at a time.");
    }

    const track = await this.resolver.resolve({
      query: normalizedQuery,
      requestedBy: interaction.user.username,
      requestedById: interaction.user.id,
      preferAudioOnly: this.shouldPreferAudioOnly(guild.id, normalizedQuery)
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
      requestedById: message.author.id,
      preferAudioOnly: this.shouldPreferAudioOnly(guild.id, normalizedQuery)
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
      throw new Error("Use `play` for playlists. `insert` only supports one track at a time.");
    }

    const track = await this.resolver.resolve({
      query: normalizedQuery,
      requestedBy: message.author.username,
      requestedById: message.author.id,
      preferAudioOnly: this.shouldPreferAudioOnly(guild.id, normalizedQuery)
    });
    this.assertTrackWithinLimit(guild.id, track);

    await player.enqueue(track, 0);
    return track;
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    return this.resolver.search(query, limit);
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

    if (!this.isLavalinkSupportedPlaylistUrl(normalizedQuery)) {
      throw new Error(
        "That playlist provider is not configured for playlist expansion yet. Spotify, YouTube playlists, and SoundCloud sets can be queued with `/play query` right now."
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
        playbackProvider: sourceProvider === "soundcloud" ? "soundcloud" : "youtube",
        playbackUrl: sourceUrl,
        encodedTrack: track.encoded,
        addedAt: new Date().toISOString()
      };
      this.assertTrackWithinLimit(guildId, resolved, `The playlist track **${resolved.title}**`);
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
      || (host.includes("spotify.com") && /\/playlist\//i.test(url.pathname))
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

  private shouldPreferAudioOnly(guildId: string, query: string) {
    const settings = this.getGuildSettings(guildId);
    if (!settings.preferAudioOnly) {
      return false;
    }

    const parsed = this.parseHttpUrl(query);
    return !parsed;
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

  async handleVoteSkip(interaction: ChatInputCommandInteraction) {
    const guild = interaction.guild;
    const guildId = interaction.guildId;
    if (!guild || !guildId) {
      throw new Error("This command must be used in a server.");
    }

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

    const member = await guild.members.fetch(interaction.user.id);
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
    await this.store.setPlaylist(guildId, playlist);
    return playlist;
  }

  async addCurrentToPlaylist(guildId: string, name: string, createdById: string) {
    const snapshot = this.getSnapshot(guildId);
    if (!snapshot.current) {
      throw new Error("Nothing is playing right now.");
    }

    const existing = this.store.getPlaylist(guildId, name);
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
    await this.store.setPlaylist(guildId, playlist);
    return playlist;
  }

  async loadPlaylist(interaction: ChatInputCommandInteraction, name: string) {
    const guildId = interaction.guildId;
    if (!guildId) {
      throw new Error("This command must be used in a server.");
    }

    const playlist = this.store.getPlaylist(guildId, name);
    if (!playlist) {
      throw new Error("That playlist does not exist.");
    }
    this.assertPlaylistWithinLimit(guildId, playlist.tracks.length);
    for (const track of playlist.tracks) {
      this.assertTrackWithinLimit(guildId, track, `The playlist track **${track.title}**`);
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

  async loadPlaylistFromMessage(message: Message, name: string) {
    const guild = message.guild;
    if (!guild) {
      throw new Error("This command must be used in a server.");
    }

    const playlist = this.store.getPlaylist(guild.id, name);
    if (!playlist) {
      throw new Error("That playlist does not exist.");
    }

    this.assertPlaylistWithinLimit(guild.id, playlist.tracks.length);
    for (const track of playlist.tracks) {
      this.assertTrackWithinLimit(guild.id, track, `The playlist track **${track.title}**`);
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

  listPlaylists(guildId: string) {
    return this.store.getPlaylists(guildId);
  }

  async deletePlaylist(guildId: string, name: string) {
    await this.store.deletePlaylist(guildId, name);
  }

  getCurrentTrack(guildId: string) {
    return this.getSnapshot(guildId).current;
  }

  getSnapshot(guildId: string): QueueSnapshot {
    const player = this.players.get(guildId);
    if (player) {
      return player.snapshot();
    }

    const settings = this.getGuildSettings(guildId);
    const persisted = this.store.getGuildPlayer(guildId);
    return {
      guildId,
      guildName: persisted?.guildName ?? this.client.guilds.cache.get(guildId)?.name ?? guildId,
      voiceChannelId: persisted?.voiceChannelId,
      textChannelId: persisted?.textChannelId,
      isPlaying: false,
      isPaused: false,
      volume: persisted?.volume ?? 75,
      filterPreset: persisted?.filterPreset ?? "off",
      autoplay: settings.autoplay,
      voteSkipEnabled: settings.voteSkipEnabled,
      permissionMode: settings.permissionMode,
      current: persisted?.current,
      previous: persisted?.history.at(-1),
      upcoming: persisted?.queue ?? []
    };
  }

  listSnapshots(): QueueSnapshot[] {
    const live = new Set(this.players.keys());
    const snapshots = [...this.players.values()].map((player) => player.snapshot());

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

  async assertBotOwner(member: GuildMember) {
    if (this.isBotOwnerId(member.id)) {
      return;
    }

    throw new Error("Only configured bot owners can use that command.");
  }

  async assertCanControl(member: GuildMember, guildId: string) {
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

  async assertCanUseCommand(member: GuildMember, guildId: string, commandName: string, channelId: string) {
    if (this.isModerator(member)) {
      return;
    }

    const settings = this.getGuildSettings(guildId);
    if (settings.memberPermissions[member.id] === "deny") {
      throw new Error("You are not allowed to use this bot in this server.");
    }

    if (settings.disabledCommands.includes(commandName.toLowerCase())) {
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

          const lavalinkTrack = await this.lavalink.resolve(track.playbackUrl);
          track.encodedTrack = lavalinkTrack.encoded;
          track.durationInSeconds ??= Math.floor(lavalinkTrack.info.length / 1000);
          track.playbackUrl = lavalinkTrack.info.uri ?? track.playbackUrl;
          track.title ||= lavalinkTrack.info.title;
          track.artist ||= lavalinkTrack.info.author;
          return lavalinkTrack.encoded;
        }
      });
      const settings = this.getGuildSettings(guild.id);
      player.autoplayEnabled = settings.autoplay;
      player.voteSkipEnabled = settings.voteSkipEnabled;
      player.permissionMode = settings.permissionMode;
      this.players.set(guild.id, player);
    }

    await player.connect(voiceChannel, textChannelId);
    return player;
  }

  private getPlayerOrThrow(guildId: string) {
    const player = this.players.get(guildId);
    if (!player) {
      throw new Error("Nothing is playing in that server right now.");
    }

    return player;
  }

  private isModerator(member: GuildMember) {
    return this.isBotOwnerId(member.id)
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
      throw new Error(`That playlist is too large for this server (${trackCount} tracks > ${maxPlaylistLength}).`);
    }
  }
}
