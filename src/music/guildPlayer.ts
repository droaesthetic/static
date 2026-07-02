import { EmbedBuilder, type Guild, type Message, type VoiceBasedChannel } from "discord.js";
import { randomUUID } from "node:crypto";
import type { MessageCreateOptions } from "discord.js";
import type {
  FilterOptions,
  Player,
  TrackEndEvent,
  TrackExceptionEvent,
  TrackStuckEvent,
  WebSocketClosedEvent
} from "shoukaku";
import { appConfig } from "../config.js";
import type { FilterPreset, PlaybackHistoryEntry, QueueSnapshot, ResolvedTrack, StoredGuildPlayerState } from "../types.js";
import type { LavalinkService } from "./lavalinkService.js";
import { embedTextPayload } from "../bot/messageEmbeds.js";

const bassBoostEqualizer = [0.35, 0.25, 0.2, 0.12, 0.05, 0, -0.03, -0.04, -0.04, -0.04, 0, 0.03, 0.05, 0.05, 0.05]
  .map((gain, band) => ({ band, gain }));

const trebleBoostEqualizer = [-0.06, -0.05, -0.04, -0.02, 0, 0.04, 0.08, 0.12, 0.14, 0.16, 0.18, 0.2, 0.22, 0.24, 0.26]
  .map((gain, band) => ({ band, gain }));

/** When Lavalink/sources fail in a tight loop (e.g. repeated “parsing errors”), halt instead of starving user commands queued on the same operation chain. */
const PLAYBACK_FAILURE_WINDOW_MS = 60_000;
const PLAYBACK_FAILURE_THRESHOLD = 4;
const IDLE_VOICE_DISCONNECT_MS = appConfig.idleVoiceDisconnectSeconds * 1000;
const PLAYBACK_WATCHDOG_INTERVAL_MS = appConfig.playbackWatchdogIntervalSeconds * 1000;
const STALE_PLAYER_UPDATE_MS = appConfig.stalePlayerUpdateSeconds * 1000;
const STAGNANT_POSITION_TICKS_BEFORE_RESTART = 5;
const STAGNANT_POSITION_TICKS_BEFORE_RECONNECT = 10;

export interface PlaybackControlResult {
  track?: ResolvedTrack;
  next?: ResolvedTrack;
  clearedTracks?: number;
  snapshot: QueueSnapshot;
}

function isHttpUrl(value: string | undefined) {
  return Boolean(value && /^https?:\/\//i.test(value));
}

function escapeMarkdownLinkText(value: string) {
  return value.replace(/[[\]\\]/g, "\\$&");
}

function formatLinkedTrackTitle(track: ResolvedTrack) {
  const label = `${track.title}${track.artist ? ` by ${track.artist}` : ""}`;
  const url = isHttpUrl(track.playbackUrl)
    ? track.playbackUrl
    : isHttpUrl(track.url) ? track.url : undefined;

  return url ? `**[${escapeMarkdownLinkText(label)}](${url})**` : `**${label}**`;
}

function formatDuration(totalSeconds?: number) {
  if (!totalSeconds || totalSeconds < 1) {
    return "live";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatEmbedHeading(title: string) {
  return `# __**${title}**__`;
}

const filterPresetOptions: Record<Exclude<FilterPreset, "off">, FilterOptions> = {
  bassboost: {
    equalizer: bassBoostEqualizer
  },
  nightcore: {
    timescale: { speed: 1.12, pitch: 1.125, rate: 1.05 }
  },
  vaporwave: {
    timescale: { speed: 0.88, pitch: 0.82, rate: 1 },
    lowPass: { smoothing: 18 }
  },
  karaoke: {
    karaoke: { level: 1, monoLevel: 1, filterBand: 220, filterWidth: 100 }
  },
  trebleboost: {
    equalizer: trebleBoostEqualizer
  },
  "8d": {
    rotation: { rotationHz: 0.2 }
  }
};

export class GuildPlayer {
  private readonly queue: ResolvedTrack[];
  private readonly history: ResolvedTrack[];
  private operationChain = Promise.resolve();
  private lavalinkPlayer?: Player;
  private current?: ResolvedTrack;
  private textChannelId?: string;
  private voiceChannelId?: string;
  private sessionId?: string;
  private sessionStartedAt?: string;
  private stayInVoiceEnabled = false;
  private stayInVoiceById?: string;
  private soloSessionUserId?: string;
  private isAdvancing = false;
  private isRecoveringConnection = false;
  private ignoreNextStoppedEvent = false;
  private isPaused = false;
  private readonly temporaryPauseReasons = new Set<string>();
  private wasPausedByTemporaryHold = false;
  private temporaryPausePositionMs = 0;
  private volume: number;
  private filterPreset: FilterPreset;
  private playbackWatchdog?: ReturnType<typeof setInterval>;
  private idleDisconnectTimer?: ReturnType<typeof setTimeout>;
  private lastPlayerUpdateAt = 0;
  private lastKnownPositionMs = 0;
  private lastWatchdogPositionMs = 0;
  private stagnantWatchdogTicks = 0;
  private nowPlayingMessageId?: string;
  private nowPlayingMessageChannelId?: string;
  private stickyTimer?: ReturnType<typeof setTimeout>;
  private queueEmptyMessageId?: string;
  private queueEmptyMessageChannelId?: string;
  private playbackFailureTimestamps: number[] = [];
  private nextTrackWarmup?: { key: string; promise: Promise<string | undefined> };
  private readonly canSendAnnouncements: (channelId: string) => boolean;
  private readonly onStateChange: (state: StoredGuildPlayerState | null) => Promise<void>;
  private readonly onPlaybackAdvanced: () => void;
  private readonly onTrackFinished: (track: ResolvedTrack) => Promise<ResolvedTrack | null>;
  private readonly onTrackRecorded: (entry: PlaybackHistoryEntry) => Promise<void>;
  private readonly resolvePlaybackTrack: (track: ResolvedTrack) => Promise<string>;
  private readonly resolvePlaybackRetry: (track: ResolvedTrack, failedPlaybackUrls: string[]) => Promise<ResolvedTrack | null>;
  autoplayEnabled = false;
  voteSkipEnabled = false;
  removeAfterPlayed = false;
  permissionMode: QueueSnapshot["permissionMode"] = "everyone";

  constructor(
    private readonly guild: Guild,
    private readonly lavalink: LavalinkService,
    options: {
      canSendAnnouncements: (channelId: string) => boolean;
      onStateChange: (state: StoredGuildPlayerState | null) => Promise<void>;
      onPlaybackAdvanced?: () => void;
      onTrackFinished: (track: ResolvedTrack) => Promise<ResolvedTrack | null>;
      onTrackRecorded?: (entry: PlaybackHistoryEntry) => Promise<void>;
      resolvePlaybackTrack: (track: ResolvedTrack) => Promise<string>;
      resolvePlaybackRetry?: (track: ResolvedTrack, failedPlaybackUrls: string[]) => Promise<ResolvedTrack | null>;
      restoredState?: StoredGuildPlayerState;
    }
  ) {
    this.canSendAnnouncements = options.canSendAnnouncements;
    this.onStateChange = options.onStateChange;
    this.onPlaybackAdvanced = options.onPlaybackAdvanced ?? (() => undefined);
    this.onTrackFinished = options.onTrackFinished;
    this.onTrackRecorded = options.onTrackRecorded ?? (async () => undefined);
    this.resolvePlaybackTrack = options.resolvePlaybackTrack;
    this.resolvePlaybackRetry = options.resolvePlaybackRetry ?? (async () => null);
    this.queue = [...(options.restoredState?.queue ?? [])];
    this.history = [...(options.restoredState?.history ?? [])];
    this.current = options.restoredState?.current;
    this.textChannelId = options.restoredState?.textChannelId;
    this.voiceChannelId = options.restoredState?.voiceChannelId;
    this.sessionId = options.restoredState?.sessionId;
    this.sessionStartedAt = options.restoredState?.sessionStartedAt;
    this.stayInVoiceEnabled = options.restoredState?.stayInVoiceEnabled ?? false;
    this.stayInVoiceById = options.restoredState?.stayInVoiceById;
    this.soloSessionUserId = options.restoredState?.soloSessionUserId;
    this.volume = options.restoredState?.volume ?? appConfig.defaultVolume;
    this.filterPreset = options.restoredState?.filterPreset ?? "off";
  }

  async connect(voiceChannel: VoiceBasedChannel, textChannelId: string) {
    return this.runExclusive(async () => {
      const previousVoiceChannelId = this.voiceChannelId;
      if (!previousVoiceChannelId || !this.sessionId || !this.sessionStartedAt) {
        this.beginSession(voiceChannel);
      }

      this.voiceChannelId = voiceChannel.id;
      this.textChannelId = textChannelId;

      if (!this.lavalinkPlayer || previousVoiceChannelId !== voiceChannel.id) {
        await this.attachToVoiceChannel(voiceChannel);
      }

      await this.rehydratePlaybackAfterConnect();
      await this.persist();
    });
  }

  async enqueue(track: ResolvedTrack, position?: number) {
    return this.runExclusive(async () => {
      await this.enqueueInternal(track, position);
    });
  }

  async enqueueMany(tracks: ResolvedTrack[]) {
    return this.runExclusive(async () => {
      for (const track of tracks) {
        await this.enqueueInternal(track);
      }
    });
  }

  async pause() {
    return this.runExclusive(async () => {
      if (!this.current && !this.lavalinkPlayer?.track) {
        throw new Error("Nothing is playing right now.");
      }

      this.wasPausedByTemporaryHold = false;
      this.isPaused = true;
      await this.lavalinkPlayer?.setPaused(true);
      await this.persist();
      return { track: this.current, snapshot: this.snapshot() };
    });
  }

  async resume() {
    return this.runExclusive(async () => {
      if (!this.current && !this.lavalinkPlayer?.track) {
        throw new Error("Nothing is playing right now.");
      }

      if (this.temporaryPauseReasons.size > 0) {
        this.isPaused = Boolean(this.current);
        await this.lavalinkPlayer?.setPaused(this.isPaused).catch((error) => {
          console.warn(`[lavalink:${this.guild.id}] failed to keep playback paused during temporary hold`, error);
        });
        await this.persist();
        return { track: this.current, snapshot: this.snapshot() };
      }

      this.wasPausedByTemporaryHold = false;
      this.isPaused = false;
      await this.lavalinkPlayer?.setPaused(false);
      await this.persist();
      return { track: this.current, snapshot: this.snapshot() };
    });
  }

  async holdTemporaryPause(reason: string) {
    return this.runExclusive(async () => {
      await this.holdTemporaryPauseInternal(reason);
    });
  }

  async releaseTemporaryPause(reason: string) {
    return this.runExclusive(async () => {
      await this.releaseTemporaryPauseInternal(reason);
    });
  }

  async stop() {
    return this.runExclusive(async () => {
      const stopped = this.current;
      const clearedTracks = this.queue.length;
      await this.haltPlaybackSession({ disconnectFromVoice: false });
      return { track: stopped, clearedTracks, snapshot: this.snapshot() };
    });
  }

  async disconnect() {
    return this.runExclusive(async () => {
      await this.haltPlaybackSession();
    });
  }

  /**
   * Teardown playback without nesting `runExclusive` — safe to await from handlers that already run on the player's operation chain.
   */
  private async haltPlaybackSession(options?: {
    logReason?: string;
    announceInChannel?: boolean;
    disconnectFromVoice?: boolean;
  }) {
    if (options?.logReason) {
      console.error(`[lavalink:${this.guild.id}] ${options.logReason}`);
    }

    const disconnectFromVoice = options?.disconnectFromVoice ?? true;
    if (this.stickyTimer) {
      clearTimeout(this.stickyTimer);
      this.stickyTimer = undefined;
    }
    this.clearPlaybackFailures();
    this.queue.length = 0;
    this.current = undefined;
    this.isPaused = false;
    this.wasPausedByTemporaryHold = false;
    this.temporaryPausePositionMs = 0;
    this.temporaryPauseReasons.clear();
    this.ignoreNextStoppedEvent = true;

    if (this.lavalinkPlayer) {
      await this.lavalinkPlayer.stopTrack().catch(() => undefined);
    }

    if (disconnectFromVoice) {
      await this.leaveVoiceConnection();
    }

    this.stopPlaybackWatchdog();
    await this.deleteNowPlayingMessage();
    await this.deleteQueueEmptyMessage();

    if (options?.announceInChannel) {
      await this.sendAutoHaltAnnouncement();
    }

    if (disconnectFromVoice) {
      this.history.length = 0;
      this.clearSession();
      this.voiceChannelId = undefined;
      this.stayInVoiceEnabled = false;
      this.stayInVoiceById = undefined;
      this.soloSessionUserId = undefined;
    }
    await this.persist();
  }

  private clearPlaybackFailures() {
    this.playbackFailureTimestamps.length = 0;
  }

  private async holdTemporaryPauseInternal(reason: string) {
    if (this.temporaryPauseReasons.has(reason)) {
      return;
    }

    this.temporaryPauseReasons.add(reason);
    if (!this.current) {
      await this.persist();
      return;
    }

    if (!this.isPaused) {
      this.wasPausedByTemporaryHold = true;
    }

    this.temporaryPausePositionMs = Math.max(
      this.temporaryPausePositionMs,
      this.lastKnownPositionMs,
      this.lavalinkPlayer?.position ?? 0
    );
    this.isPaused = true;
    await this.lavalinkPlayer?.setPaused(true).catch((error) => {
      console.warn(`[lavalink:${this.guild.id}] failed to apply temporary pause hold`, error);
    });
    await this.persist();
  }

  private async releaseTemporaryPauseInternal(reason: string) {
    if (!this.temporaryPauseReasons.delete(reason)) {
      return;
    }

    if (this.temporaryPauseReasons.size > 0) {
      await this.persist();
      return;
    }

    if (this.wasPausedByTemporaryHold && this.current) {
      this.wasPausedByTemporaryHold = false;
      const resumeAtSeconds = Math.floor(Math.max(
        this.temporaryPausePositionMs,
        this.lastKnownPositionMs,
        this.lavalinkPlayer?.position ?? 0
      ) / 1000);
      this.temporaryPausePositionMs = 0;

      if (!this.lavalinkPlayer?.track) {
        console.warn(
          `[lavalink:${this.guild.id}] restarting interrupted track at ${resumeAtSeconds}s after temporary pause`
        );
        await this.startTrack(this.current, resumeAtSeconds, false);
        await this.persist();
        return;
      }

      this.isPaused = false;
      await this.lavalinkPlayer?.setPaused(false).catch((error) => {
        console.warn(`[lavalink:${this.guild.id}] failed to release temporary pause hold`, error);
      });
    }

    await this.persist();
  }

  private beginSession(voiceChannel: VoiceBasedChannel) {
    this.sessionId = randomUUID();
    this.sessionStartedAt = new Date().toISOString();
    this.history.length = 0;
    this.voiceChannelId = voiceChannel.id;
  }

  private clearSession() {
    this.sessionId = undefined;
    this.sessionStartedAt = undefined;
  }

  private async rememberFinishedTrack(track: ResolvedTrack) {
    this.history.push(track);
    if (this.history.length > 25) {
      this.history.shift();
    }

    if (!this.sessionId || !this.sessionStartedAt) {
      return;
    }

    await this.onTrackRecorded({
      id: randomUUID(),
      guildId: this.guild.id,
      sessionId: this.sessionId,
      sessionStartedAt: this.sessionStartedAt,
      voiceChannelId: this.voiceChannelId,
      voiceChannelName: this.getVoiceChannelName(),
      playedAt: new Date().toISOString(),
      track
    }).catch((error) => {
      console.error(`[history:${this.guild.id}] failed to record played track`, error);
    });
  }

  private getVoiceChannelName() {
    if (!this.voiceChannelId) {
      return undefined;
    }

    const channel = this.guild.channels.cache.get(this.voiceChannelId);
    return channel && "name" in channel ? channel.name : undefined;
  }

  /** Returns true when too many failures recently (caller should halt playback). */
  private recordPlaybackFailure(): boolean {
    const now = Date.now();
    this.playbackFailureTimestamps.push(now);
    this.playbackFailureTimestamps = this.playbackFailureTimestamps.filter(
      (t) => now - t < PLAYBACK_FAILURE_WINDOW_MS
    );
    return this.playbackFailureTimestamps.length >= PLAYBACK_FAILURE_THRESHOLD;
  }

  async skip() {
    return this.runExclusive(async () => {
      return this.skipCurrentTrack();
    });
  }

  async skipTo(index: number) {
    return this.runExclusive(async () => {
      if (index < 1 || index > this.queue.length) {
        throw new Error("That queue position does not exist.");
      }

      this.queue.splice(0, index - 1);
      await this.persist();
      return this.skipCurrentTrack();
    });
  }

  async playPrevious() {
    return this.runExclusive(async () => {
      const previous = this.history.pop();
      if (!previous) {
        throw new Error("There is no previous track to play.");
      }

      if (this.current) {
        this.queue.unshift(this.current);
      }

      this.queue.unshift(previous);
      await this.persist();
      return this.skipCurrentTrack();
    });
  }

  async remove(index: number) {
    return this.runExclusive(async () => {
      if (index < 1 || index > this.queue.length) {
        throw new Error("That queue position does not exist.");
      }

      const [removed] = this.queue.splice(index - 1, 1);
      await this.persist();
      this.scheduleNextTrackWarmup();
      return removed;
    });
  }

  async move(from: number, to: number) {
    return this.runExclusive(async () => {
      if (from < 1 || from > this.queue.length) {
        throw new Error("The source queue position does not exist.");
      }

      if (to < 1 || to > this.queue.length) {
        throw new Error("The target queue position does not exist.");
      }

      const [moved] = this.queue.splice(from - 1, 1);
      if (!moved) {
        throw new Error("The source queue position does not exist.");
      }

      this.queue.splice(to - 1, 0, moved);
      await this.persist();
      this.scheduleNextTrackWarmup();
      return moved;
    });
  }

  async removeLast() {
    return this.runExclusive(async () => {
      const removed = this.queue.pop();
      await this.persist();
      this.scheduleNextTrackWarmup();
      return removed;
    });
  }

  async removeDuplicates() {
    return this.runExclusive(async () => {
      const seen = new Set<string>();
      if (this.current) {
        seen.add(`${this.current.title.toLowerCase()}::${this.current.artist?.toLowerCase() ?? ""}`);
      }

      const before = this.queue.length;
      const filtered = this.queue.filter((track) => {
        const key = `${track.title.toLowerCase()}::${track.artist?.toLowerCase() ?? ""}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      this.queue.splice(0, this.queue.length, ...filtered);
      await this.persist();
      this.scheduleNextTrackWarmup();
      return before - this.queue.length;
    });
  }

  async removeAbsentMembers(activeMemberIds: Set<string>) {
    return this.runExclusive(async () => {
      const before = this.queue.length;
      const filtered = this.queue.filter((track) => activeMemberIds.has(track.requestedById));
      this.queue.splice(0, this.queue.length, ...filtered);

      let removed = before - filtered.length;
      const removeCurrent = this.current ? !activeMemberIds.has(this.current.requestedById) : false;

      await this.persist();
      this.scheduleNextTrackWarmup();

      if (removeCurrent) {
        removed += 1;
        await this.skipCurrentTrack();
      }

      return removed;
    });
  }

  async massRemove(upcomingIndices: number[]) {
    return this.runExclusive(async () => {
      const sortedIndices = Array.from(new Set(upcomingIndices)).sort((a, b) => b - a);

      let removedCount = 0;
      for (const index of sortedIndices) {
        if (index < 1 || index > this.queue.length) {
          continue;
        }
        this.queue.splice(index - 1, 1);
        removedCount++;
      }

      if (removedCount > 0) {
        await this.persist();
        this.scheduleNextTrackWarmup();
      }

      return removedCount;
    });
  }

  async shuffleQueue() {
    return this.runExclusive(async () => {
      const count = this.queue.length;
      for (let index = count - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [this.queue[index], this.queue[swapIndex]] = [this.queue[swapIndex], this.queue[index]];
      }

      await this.persist();
      this.scheduleNextTrackWarmup();
      return count;
    });
  }

  async clearQueue() {
    return this.runExclusive(async () => {
      const count = this.queue.length;
      this.queue.length = 0;
      await this.persist();
      this.scheduleNextTrackWarmup();
      return count;
    });
  }

  async clearUserQueue(userId: string) {
    return this.runExclusive(async () => {
      const before = this.queue.length;
      const filtered = this.queue.filter((track) => track.requestedById !== userId);
      this.queue.splice(0, this.queue.length, ...filtered);
      const count = before - filtered.length;
      if (count > 0) {
        await this.persist();
        this.scheduleNextTrackWarmup();
      }
      return count;
    });
  }

  async clearAnnouncements(channelId?: string) {
    return this.runExclusive(async () => {
      if (!channelId || this.nowPlayingMessageChannelId === channelId) {
        await this.deleteNowPlayingMessage();
      }

      if (!channelId || this.queueEmptyMessageChannelId === channelId) {
        await this.deleteQueueEmptyMessage();
      }
    });
  }

  async autoFix() {
    return this.runExclusive(async () => {
      const actions: string[] = [];
      this.clearPlaybackFailures();

      if (!this.voiceChannelId) {
        return {
          applied: false,
          actions: ["No active voice session was found. Start one with /join or /play."]
        };
      }

      if (!this.current && this.queue.length > 0) {
        await this.maybeContinuePlaybackChain();
        return {
          applied: true,
          actions: ["Restarted playback from the next queued song."]
        };
      }

      if (this.current && (!this.lavalinkPlayer || !this.lavalinkPlayer.track)) {
        await this.recoverCurrentPlayback("manual fix command: missing player or track");
        return {
          applied: true,
          actions: ["Rebuilt the voice player and tried to resume the current song."]
        };
      }

      const updateAgeMs = this.lastPlayerUpdateAt ? Date.now() - this.lastPlayerUpdateAt : 0;
      if (this.current && updateAgeMs > 45_000) {
        await this.recoverCurrentPlayback(`manual fix command: stale player updates for ${Math.round(updateAgeMs / 1000)}s`);
        return {
          applied: true,
          actions: ["Refreshed the voice connection because playback updates looked stale."]
        };
      }

      this.syncIdleDisconnectTimer();
      actions.push("Checked the player, voice connection, queue, and playback watchdog state.");
      actions.push("No automatic repair was needed.");
      return { applied: false, actions };
    });
  }

  async setVolume(percent: number) {
    return this.runExclusive(async () => {
      this.volume = Math.max(1, Math.min(150, percent));
      await this.lavalinkPlayer?.setGlobalVolume(this.volume);
      await this.persist();
    });
  }

  async setFilterPreset(preset: FilterPreset) {
    return this.runExclusive(async () => {
      this.filterPreset = preset;
      await this.applyCurrentFilterPreset();
      await this.persist();
      return this.filterPreset;
    });
  }

  async setStayInVoice(enabled: boolean, userId?: string) {
    return this.runExclusive(async () => {
      if (enabled && !this.voiceChannelId) {
        throw new Error("The bot must be in a voice channel before 24/7 voice can be enabled.");
      }

      this.stayInVoiceEnabled = enabled;
      this.stayInVoiceById = enabled ? userId : undefined;
      await this.persist();
      return this.stayInVoiceEnabled;
    });
  }

  async setSoloSession(enabled: boolean, userId: string) {
    return this.runExclusive(async () => {
      if (enabled && !this.voiceChannelId) {
        throw new Error("The bot must be in a voice channel before solo session can be enabled.");
      }

      if (enabled && this.soloSessionUserId && this.soloSessionUserId !== userId) {
        throw new Error(`<@${this.soloSessionUserId}> already has solo session enabled.`);
      }

      this.soloSessionUserId = enabled ? userId : undefined;
      await this.persist();
      return this.soloSessionUserId;
    });
  }

  async clearSoloSessionForUser(userId: string) {
    return this.runExclusive(async () => {
      if (this.soloSessionUserId !== userId) {
        return false;
      }

      this.soloSessionUserId = undefined;
      await this.persist();
      return true;
    });
  }

  getCurrentPositionSeconds() {
    return this.lavalinkPlayer ? Math.floor(this.lavalinkPlayer.position / 1000) : 0;
  }

  async seekTo(seconds: number) {
    return this.runExclusive(async () => {
      if (!this.current || !this.lavalinkPlayer) {
        throw new Error("Nothing is playing right now.");
      }

      await this.lavalinkPlayer.seekTo(Math.max(0, seconds) * 1000);
    });
  }

  snapshot(): QueueSnapshot {
    return {
      guildId: this.guild.id,
      guildName: this.guild.name,
      voiceChannelId: this.voiceChannelId,
      textChannelId: this.textChannelId,
      sessionId: this.sessionId,
      sessionStartedAt: this.sessionStartedAt,
      stayInVoiceEnabled: this.stayInVoiceEnabled,
      stayInVoiceById: this.stayInVoiceById,
      soloSessionUserId: this.soloSessionUserId,
      isPlaying: Boolean(this.current) && !this.isPaused,
      isPaused: this.isPaused,
      volume: this.volume,
      filterPreset: this.filterPreset,
      autoplay: this.autoplayEnabled,
      voteSkipEnabled: this.voteSkipEnabled,
      removeAfterPlayed: this.removeAfterPlayed,
      permissionMode: this.permissionMode,
      current: this.current,
      previous: this.history.at(-1),
      played: [...this.history],
      upcoming: [...this.queue]
    };
  }

  serialize(): StoredGuildPlayerState {
    return {
      guildId: this.guild.id,
      guildName: this.guild.name,
      voiceChannelId: this.voiceChannelId,
      textChannelId: this.textChannelId,
      sessionId: this.sessionId,
      sessionStartedAt: this.sessionStartedAt,
      stayInVoiceEnabled: this.stayInVoiceEnabled,
      stayInVoiceById: this.stayInVoiceById,
      soloSessionUserId: this.soloSessionUserId,
      volume: this.volume,
      filterPreset: this.filterPreset,
      current: this.current,
      queue: [...this.queue],
      history: [...this.history]
    };
  }

  private attachPlayerListeners(player: Player) {
    this.detachPlayerListeners(player);

    player.on("end", (event) => {
      void this.runExclusive(() => this.handleTrackEnd(event)).catch((error) => {
        console.error(`[lavalink:${this.guild.id}] failed to handle track end`, error);
      });
    });

    player.on("stuck", (event) => {
      void this.runExclusive(() => this.handleTrackStuck(event)).catch((error) => {
        console.error(`[lavalink:${this.guild.id}] failed to handle track stuck`, error);
      });
    });

    player.on("exception", (event) => {
      void this.runExclusive(() => this.handleTrackException(event)).catch((error) => {
        console.error(`[lavalink:${this.guild.id}] failed to handle track exception`, error);
      });
    });

    player.on("closed", (event) => {
      void this.runExclusive(() => this.handleVoiceClosed(event)).catch((error) => {
        console.error(`[lavalink:${this.guild.id}] failed to handle websocket close`, error);
      });
    });

    player.on("start", () => {
      this.clearPlaybackFailures();
      this.lastPlayerUpdateAt = Date.now();
      this.lastKnownPositionMs = 0;
      this.lastWatchdogPositionMs = 0;
      this.stagnantWatchdogTicks = 0;
    });

    player.on("update", () => {
      this.lastPlayerUpdateAt = Date.now();
      this.lastKnownPositionMs = Math.max(this.lastKnownPositionMs, player.position);
    });

    player.on("resumed", () => {
      console.log(`[lavalink:${this.guild.id}] player resumed by library`);
      this.lastPlayerUpdateAt = Date.now();
    });
  }

  private detachPlayerListeners(player: Player) {
    player.removeAllListeners("end");
    player.removeAllListeners("stuck");
    player.removeAllListeners("exception");
    player.removeAllListeners("closed");
    player.removeAllListeners("start");
    player.removeAllListeners("update");
    player.removeAllListeners("resumed");
  }

  private async advancePlaybackChain(options?: { recordCurrent?: boolean; allowAutoplay?: boolean }) {
    const recordCurrent = options?.recordCurrent ?? true;
    const allowAutoplay = options?.allowAutoplay ?? true;
    const finished = this.current;
    if (finished) {
      await this.deleteNowPlayingMessage();
      this.onPlaybackAdvanced();
    }

    /** Only pushed after a successor track successfully starts or the queue genuinely ends — avoids corrupting history if `startTrack` throws. */
    let finishedToHistory: ResolvedTrack | undefined = recordCurrent ? finished : undefined;
    let autoplaySeed = allowAutoplay ? finished : undefined;

    while (true) {
      let next = this.queue.shift();
      if (!next && autoplaySeed) {
        next = (await this.onTrackFinished(autoplaySeed)) ?? undefined;
        autoplaySeed = undefined;
      }

      if (!next) {
        if (finishedToHistory) {
          await this.rememberFinishedTrack(finishedToHistory);
        }

        this.current = undefined;
        this.isPaused = false;
        this.stopPlaybackWatchdog();
        await this.sendQueueEmptyMessage();
        await this.persist();
        return;
      }

      try {
        await this.startTrack(next, 0);
        if (finishedToHistory) {
          await this.rememberFinishedTrack(finishedToHistory);
        }

        return;
      } catch (error) {
        console.error(`[lavalink:${this.guild.id}] failed to start queued track "${next.title}"`, error);
        if (this.recordPlaybackFailure()) {
          await this.haltPlaybackSession({
            logReason:
              "Too many playback or start failures in a short window - stopping the voice session before the queue can tight-loop.",
            announceInChannel: true
          });
          return;
        }
      }
    }
  }

  private async startTrack(track: ResolvedTrack, seekSeconds: number, announceNowPlaying = true) {
    this.isAdvancing = true;

    try {
      if (!this.lavalinkPlayer) {
        throw new Error("The bot is not connected to a Lavalink player.");
      }

      await this.deleteQueueEmptyMessage();
      const encoded = await this.resolveTrackForPlayback(track);
      this.current = track;
      this.isPaused = this.temporaryPauseReasons.size > 0;
      if (this.isPaused) {
        this.wasPausedByTemporaryHold = true;
      }
      this.lastPlayerUpdateAt = Date.now();
      this.lastKnownPositionMs = seekSeconds * 1000;
      this.lastWatchdogPositionMs = this.lastKnownPositionMs;
      this.stagnantWatchdogTicks = 0;
      await this.persist();
      await this.lavalink.play(this.lavalinkPlayer, encoded, this.volume, seekSeconds * 1000);
      if (this.isPaused) {
        await this.lavalinkPlayer.setPaused(true).catch((error) => {
          console.warn(`[lavalink:${this.guild.id}] failed to apply temporary pause after track start`, error);
        });
      }
      this.startPlaybackWatchdog();
      if (announceNowPlaying) {
        await this.sendNowPlayingMessage(track);
      }
      this.scheduleNextTrackWarmup();
    } finally {
      this.isAdvancing = false;
    }
  }

  private async resolveTrackForPlayback(track: ResolvedTrack) {
    const key = this.warmupKey(track);
    if (this.nextTrackWarmup?.key === key) {
      const warmed = await this.nextTrackWarmup.promise;
      if (warmed) {
        return warmed;
      }
    }

    return this.resolvePlaybackTrack(track);
  }

  private scheduleNextTrackWarmup() {
    if (!appConfig.preResolveNextTrack) {
      return;
    }

    const track = this.queue[0];
    if (!track || track.encodedTrack || track.playbackProvider === "upload") {
      this.nextTrackWarmup = undefined;
      return;
    }

    const key = this.warmupKey(track);
    if (this.nextTrackWarmup?.key === key) {
      return;
    }

    const promise = this.resolvePlaybackTrack(track)
      .catch((error) => {
        console.warn(`[lavalink:${this.guild.id}] failed to pre-resolve next track "${track.title}"`, error);
        return undefined;
      })
      .finally(() => {
        if (this.nextTrackWarmup?.key === key) {
          this.nextTrackWarmup = undefined;
        }
      });

    this.nextTrackWarmup = { key, promise };
  }

  private warmupKey(track: ResolvedTrack) {
    return `${track.id}:${track.playbackProvider}:${track.playbackUrl}:${track.searchQuery ?? ""}`;
  }

  private async persist() {
    await this.onStateChange(this.serialize());
    this.syncIdleDisconnectTimer();
  }

  private async attachToVoiceChannel(voiceChannel: VoiceBasedChannel) {
    if (this.lavalinkPlayer) {
      await this.leaveVoiceConnection();
    }

    this.lavalinkPlayer = await this.lavalink.join(
      voiceChannel.guild.id,
      voiceChannel.id,
      voiceChannel.guild.shardId
    );
    this.attachPlayerListeners(this.lavalinkPlayer);
    this.lastPlayerUpdateAt = Date.now();
    await this.lavalinkPlayer.setGlobalVolume(this.volume);
    await this.applyCurrentFilterPreset();

    if (this.isPaused) {
      await this.lavalinkPlayer.setPaused(true);
    }
  }

  private async rehydratePlaybackAfterConnect() {
    if (!this.lavalinkPlayer) {
      return;
    }

    if (this.current && !this.isPaused && !this.lavalinkPlayer.track) {
      console.warn(
        `[lavalink:${this.guild.id}] restored player state had a current track but no live Lavalink track; restarting playback`
      );
      try {
        await this.startTrack(this.current, 0, false);
      } catch (error) {
        console.warn(`[lavalink:${this.guild.id}] failed to restart restored current track; clearing stale current`, error);
        this.current = undefined;
        this.isPaused = false;
        this.stopPlaybackWatchdog();
        if (this.queue.length > 0) {
          await this.maybeContinuePlaybackChain();
        }
      }
      return;
    }

    if (!this.current && this.queue.length > 0) {
      await this.maybeContinuePlaybackChain();
    } else {
      this.scheduleNextTrackWarmup();
    }
  }

  private async handleTrackEnd(event: TrackEndEvent) {
    console.log(
      `[lavalink:${this.guild.id}] track ended reason=${event.reason} current=${this.current?.title ?? "none"}`
    );

    if (event.reason === "stopped" && this.ignoreNextStoppedEvent) {
      this.ignoreNextStoppedEvent = false;
      return;
    }

    if (this.isAdvancing || this.isRecoveringConnection) {
      return;
    }

    if (!this.current) {
      console.warn(
        `[lavalink:${this.guild.id}] ignoring ${event.reason} track end with no current track`
      );
      if (this.queue.length > 0) {
        await this.maybeContinuePlaybackChain();
      }
      return;
    }

    if (this.temporaryPauseReasons.size > 0) {
      this.temporaryPausePositionMs = Math.max(
        this.temporaryPausePositionMs,
        this.lastKnownPositionMs,
        this.lavalinkPlayer?.position ?? 0
      );
      this.isPaused = true;
      console.warn(
        `[lavalink:${this.guild.id}] preserving current track after ${event.reason} during temporary pause`
      );
      await this.persist();
      return;
    }

    if (event.reason === "replaced") {
      return;
    }

    if (event.reason === "finished") {
      this.clearPlaybackFailures();
      await this.advancePlaybackChain();
      return;
    }

    if (event.reason === "loadFailed") {
      if (await this.retryCurrentTrackPlayback()) {
        return;
      }
    }

    if (event.reason === "cleanup") {
      if (this.recordPlaybackFailure()) {
        await this.haltPlaybackSession({
          logReason:
            `Repeated track end failures (${event.reason}) - stopping the voice session before playback can loop through bad sources.`,
          announceInChannel: true
        });
        return;
      }

      if (await this.recoverCurrentPlayback(`track end reason=${event.reason}`)) {
        return;
      }
    }

    if (event.reason === "loadFailed") {
      if (this.recordPlaybackFailure()) {
        await this.haltPlaybackSession({
          logReason:
            `Repeated track end failures (${event.reason}) - stopping the voice session before playback can loop through bad sources.`,
          announceInChannel: true
        });
        return;
      }
    }

    await this.advancePlaybackChain({ recordCurrent: false, allowAutoplay: false });
  }

  private async retryCurrentTrackPlayback() {
    const track = this.current;
    if (!track || track.playbackProvider === "upload") {
      return false;
    }

    const failedPlaybackUrls = this.uniquePlaybackUrls([
      ...(track.failedPlaybackUrls ?? []),
      track.playbackUrl
    ]);
    track.failedPlaybackUrls = failedPlaybackUrls;
    track.encodedTrack = undefined;

    try {
      const retryTrack = await this.resolvePlaybackRetry(track, failedPlaybackUrls);
      if (!retryTrack) {
        return false;
      }

      const previousUrl = track.playbackUrl;
      track.title = retryTrack.title;
      track.artist = retryTrack.artist;
      track.artwork = retryTrack.artwork;
      track.durationInSeconds = retryTrack.durationInSeconds;
      track.playbackProvider = retryTrack.playbackProvider;
      track.playbackUrl = retryTrack.playbackUrl;
      track.encodedTrack = undefined;

      console.warn(
        `[lavalink:${this.guild.id}] retrying "${track.title}" with alternate playback URL after loadFailed (${previousUrl} -> ${track.playbackUrl})`
      );

      await this.deleteNowPlayingMessage();
      await this.startTrack(track, 0);
      return true;
    } catch (error) {
      console.warn(`[lavalink:${this.guild.id}] failed to retry alternate playback URL`, error);
      return false;
    }
  }

  private uniquePlaybackUrls(urls: string[]) {
    return [...new Set(urls.filter(Boolean).map((url) => url.toLowerCase()))];
  }

  private async handleTrackStuck(event: TrackStuckEvent) {
    console.error(`[lavalink:${this.guild.id}] track stuck`, event);

    if (this.isAdvancing || this.isRecoveringConnection) {
      return;
    }

    if (this.temporaryPauseReasons.size > 0 && this.current) {
      console.warn(`[lavalink:${this.guild.id}] ignoring stuck event during temporary pause`);
      await this.persist();
      return;
    }

    if (this.recordPlaybackFailure()) {
      await this.haltPlaybackSession({
        logReason:
          "Repeated stuck tracks — stopping the voice session to avoid looping through bad sources.",
        announceInChannel: true
      });
      return;
    }

    if (await this.recoverCurrentPlayback(`track stuck after ${event.thresholdMs}ms`)) {
      return;
    }

    await this.advancePlaybackChain({ recordCurrent: false, allowAutoplay: false });
  }

  private async handleTrackException(event: TrackExceptionEvent) {
    console.error(`[lavalink:${this.guild.id}] track exception`, event);

    if (this.isAdvancing || this.isRecoveringConnection) {
      return;
    }

    if (this.temporaryPauseReasons.size > 0 && this.current) {
      console.warn(`[lavalink:${this.guild.id}] ignoring track exception during temporary pause`);
      await this.persist();
      return;
    }

    if (this.recordPlaybackFailure()) {
      await this.haltPlaybackSession({
        logReason:
          "Repeated Lavalink track exceptions (often source/parsing failures) — stopping the voice session to avoid a skip loop.",
        announceInChannel: true
      });
      return;
    }

    if (await this.recoverCurrentPlayback("track exception")) {
      return;
    }

    await this.advancePlaybackChain({ recordCurrent: false, allowAutoplay: false });
  }

  private async handleVoiceClosed(event: WebSocketClosedEvent) {
    console.error(`[lavalink:${this.guild.id}] websocket closed`, event);

    if (this.isRecoveringConnection || !this.current || !this.voiceChannelId) {
      return;
    }

    await this.holdTemporaryPauseInternal("voice-connection");
    await this.recoverCurrentPlayback(`websocket close code=${event.code}`);
  }

  private async recoverCurrentPlayback(reason: string) {
    if (this.isRecoveringConnection || !this.current || !this.voiceChannelId) {
      return false;
    }

    this.isRecoveringConnection = true;
    const resumeAtSeconds = Math.floor(Math.max(this.lastKnownPositionMs, this.lavalinkPlayer?.position ?? 0) / 1000);
    let recovered = false;

    try {
      const channel = await this.guild.channels.fetch(this.voiceChannelId);
      if (!channel?.isVoiceBased()) {
        throw new Error("The stored voice channel no longer exists or is not voice-based.");
      }

      console.warn(
        `[lavalink:${this.guild.id}] attempting playback recovery after ${reason} at ${resumeAtSeconds}s`
      );

      await this.leaveVoiceConnection();
      await this.attachToVoiceChannel(channel);

      if (this.current) {
        await this.startTrack(this.current, resumeAtSeconds, false);
        await this.releaseTemporaryPauseInternal("voice-connection");
        recovered = true;
        console.log(
          `[lavalink:${this.guild.id}] recovered current track at ${resumeAtSeconds}s`
        );
      }
    } catch (error) {
      console.error(`[lavalink:${this.guild.id}] recovery failed`, error);
      if (this.recordPlaybackFailure()) {
        await this.haltPlaybackSession({
          logReason:
            "Repeated playback recovery failures - stopping the voice session before the watchdog can loop.",
          announceInChannel: true
        });
      }
    } finally {
      this.isRecoveringConnection = false;
      await this.persist();
    }

    return recovered;
  }

  private async restartCurrentPlayback(reason: string) {
    if (this.isRecoveringConnection || !this.current || !this.lavalinkPlayer) {
      return false;
    }

    const resumeAtSeconds = Math.floor(Math.max(this.lastKnownPositionMs, this.lavalinkPlayer.position ?? 0) / 1000);
    console.warn(
      `[lavalink:${this.guild.id}] restarting current track after ${reason} at ${resumeAtSeconds}s`
    );

    try {
      await this.startTrack(this.current, resumeAtSeconds, false);
      return true;
    } catch (error) {
      console.error(`[lavalink:${this.guild.id}] current track restart failed`, error);
      if (this.recordPlaybackFailure()) {
        await this.haltPlaybackSession({
          logReason:
            "Repeated playback restart failures - stopping the voice session before the watchdog can loop.",
          announceInChannel: true
        });
      }
      return false;
    }
  }

  private startPlaybackWatchdog() {
    this.stopPlaybackWatchdog();

    this.playbackWatchdog = setInterval(() => {
      void this.runExclusive(() => this.inspectPlaybackHealth()).catch((error) => {
        console.error(`[lavalink:${this.guild.id}] playback watchdog failed`, error);
      });
    }, PLAYBACK_WATCHDOG_INTERVAL_MS);
    this.playbackWatchdog.unref?.();
  }

  private stopPlaybackWatchdog() {
    if (!this.playbackWatchdog) {
      return;
    }

    clearInterval(this.playbackWatchdog);
    this.playbackWatchdog = undefined;
    this.stagnantWatchdogTicks = 0;
  }

  private syncIdleDisconnectTimer() {
    this.clearIdleDisconnectTimer();

    if (!this.voiceChannelId || this.current || this.queue.length > 0 || this.stayInVoiceEnabled) {
      return;
    }

    this.idleDisconnectTimer = setTimeout(() => {
      void this.runExclusive(() => this.disconnectIfStillIdle()).catch((error) => {
        console.error(`[lavalink:${this.guild.id}] idle disconnect failed`, error);
      });
    }, IDLE_VOICE_DISCONNECT_MS);
    this.idleDisconnectTimer.unref?.();
  }

  private clearIdleDisconnectTimer() {
    if (!this.idleDisconnectTimer) {
      return;
    }

    clearTimeout(this.idleDisconnectTimer);
    this.idleDisconnectTimer = undefined;
  }

  private async disconnectIfStillIdle() {
    this.idleDisconnectTimer = undefined;

    if (!this.voiceChannelId || this.current || this.queue.length > 0) {
      return;
    }

    console.log(
      `[lavalink:${this.guild.id}] leaving voice after ${appConfig.idleVoiceDisconnectSeconds} seconds of inactivity`
    );
    await this.leaveVoiceConnection();

    this.voiceChannelId = undefined;
    this.history.length = 0;
    this.clearSession();
    this.soloSessionUserId = undefined;
    this.isPaused = false;
    this.stopPlaybackWatchdog();
    await this.deleteQueueEmptyMessage();
    await this.persist();
  }

  private async leaveVoiceConnection() {
    if (this.lavalinkPlayer) {
      this.detachPlayerListeners(this.lavalinkPlayer);
      this.lavalinkPlayer = undefined;
    }

    await this.lavalink.leave(this.guild.id).catch(() => undefined);
  }

  private async inspectPlaybackHealth() {
    if (!this.current || this.isPaused || this.isAdvancing || this.isRecoveringConnection) {
      return;
    }

    const player = this.lavalinkPlayer;
    if (!player || !player.track) {
      await this.recoverCurrentPlayback("missing Lavalink track");
      return;
    }

    const now = Date.now();
    const updateAgeMs = this.lastPlayerUpdateAt ? now - this.lastPlayerUpdateAt : 0;
    if (updateAgeMs > STALE_PLAYER_UPDATE_MS) {
      if (await this.restartCurrentPlayback(`stale player updates for ${Math.round(updateAgeMs / 1000)}s`)) {
        return;
      }

      await this.recoverCurrentPlayback(`stale player updates for ${Math.round(updateAgeMs / 1000)}s`);
      return;
    }

    const position = player.position;
    this.lastKnownPositionMs = Math.max(this.lastKnownPositionMs, position);
    if (position <= this.lastWatchdogPositionMs + 500) {
      this.stagnantWatchdogTicks += 1;
    } else {
      this.stagnantWatchdogTicks = 0;
      this.lastWatchdogPositionMs = position;
    }

    if (this.stagnantWatchdogTicks === STAGNANT_POSITION_TICKS_BEFORE_RESTART) {
      await this.restartCurrentPlayback("stagnant playback position");
      return;
    }

    if (this.stagnantWatchdogTicks >= STAGNANT_POSITION_TICKS_BEFORE_RECONNECT) {
      await this.recoverCurrentPlayback("stagnant playback position");
    }
  }

  private async applyCurrentFilterPreset() {
    if (!this.lavalinkPlayer) {
      return;
    }

    if (this.filterPreset === "off") {
      await this.lavalinkPlayer.clearFilters();
      return;
    }

    await this.lavalinkPlayer.setFilters(filterPresetOptions[this.filterPreset]);
  }

  private async sendNowPlayingMessage(track: ResolvedTrack) {
    const channel = await this.getAnnouncementChannel();
    if (!channel) {
      return;
    }

    await this.deleteNowPlayingMessage(channel);
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setDescription([
        formatEmbedHeading("NOW PLAYING"),
        "",
        formatLinkedTrackTitle(track)
      ].join("\n"))
      .addFields( 
        { name: "Duration", value: formatDuration(track.durationInSeconds), inline: true }, 
        { name: "Requested by", value: this.formatRequester(track), inline: true } 
      ); 
 
    if (appConfig.nowPlayingThumbnails && isHttpUrl(track.artwork)) { 
      embed.setThumbnail(track.artwork ?? null); 
    }

    const message = await channel.send({ embeds: [embed] });
    this.nowPlayingMessageId = message.id;
    this.nowPlayingMessageChannelId = channel.id;
  }

  private async sendQueueEmptyMessage() {
    const channel = await this.getAnnouncementChannel();
    if (!channel) {
      return;
    }

    await this.deleteQueueEmptyMessage(channel);
    const message = await channel.send({
      ...embedTextPayload("Queue is empty.", { title: "Queue Status", tone: "warning" })
    });
    this.queueEmptyMessageId = message.id;
    this.queueEmptyMessageChannelId = channel.id;
  }

  /**
   * Shown when the player stops itself after repeated Lavalink/source failures.
   * Ignores “bot messages off” for this channel — users should always see why playback died.
   */
  private async sendAutoHaltAnnouncement() {
    const channel = await this.getAnnouncementChannel(this.textChannelId, true);
    if (!channel) {
      return;
    }

    const body =
      "**Playback stopped automatically** after too many errors in a short time. That often happens when tracks fail to load or decode — for example outdated Lavalink / YouTube plugin issues, restricted videos, or bad links.\n\n"
      + "The queue was cleared and the bot left the voice channel. Try another song, or update your Lavalink node if this keeps happening.";

    await channel
      .send({
        ...embedTextPayload(body, { title: "Player stopped", tone: "warning" })
      })
      .catch(() => undefined);
  }

  getCurrentTrack() {
    return this.current;
  }

  getNowPlayingMessageId() {
    return this.nowPlayingMessageId;
  }

  getNowPlayingMessageChannelId() {
    return this.nowPlayingMessageChannelId;
  }

  triggerStickyNPUpdate() {
    if (this.stickyTimer) {
      clearTimeout(this.stickyTimer);
    }
    this.stickyTimer = setTimeout(async () => {
      try {
        if (this.current) {
          await this.sendNowPlayingMessage(this.current);
        }
      } catch (error) {
        console.error(`[sticky] Failed to update now playing message:`, error);
      }
    }, 1500);
  }

  private async deleteNowPlayingMessage(channel?: Awaited<ReturnType<GuildPlayer["getAnnouncementChannel"]>>) {
    if (this.stickyTimer) {
      clearTimeout(this.stickyTimer);
      this.stickyTimer = undefined;
    }
    await this.deleteTrackedMessage("nowPlayingMessageId", channel);
  }

  private async deleteQueueEmptyMessage(channel?: Awaited<ReturnType<GuildPlayer["getAnnouncementChannel"]>>) {
    await this.deleteTrackedMessage("queueEmptyMessageId", channel);
  }

  private async deleteTrackedMessage(
    key: "nowPlayingMessageId" | "queueEmptyMessageId",
    existingChannel?: Awaited<ReturnType<GuildPlayer["getAnnouncementChannel"]>>
  ) {
    const messageId = this[key];
    if (!messageId) {
      return;
    }

    const channelIdKey = key === "nowPlayingMessageId" ? "nowPlayingMessageChannelId" : "queueEmptyMessageChannelId";
    const targetChannelId = this[channelIdKey];
    const channel = existingChannel ?? await this.getAnnouncementChannel(targetChannelId, true);
    if (!channel) {
      this[key] = undefined;
      this[channelIdKey] = undefined;
      return;
    }

    await channel.messages.delete(messageId).catch(() => undefined);
    this[key] = undefined;
    this[channelIdKey] = undefined;
  }

  private async getAnnouncementChannel(channelId = this.textChannelId, ignorePreferences = false) {
    if (!channelId) {
      return null;
    }

    if (!ignorePreferences && !this.canSendAnnouncements(channelId)) {
      return null;
    }

    const channel = await this.guild.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel) || !("messages" in channel)) {
      return null;
    }

    return channel as {
      id: string;
      send: (options: MessageCreateOptions) => Promise<Message>;
      messages: { delete: (messageId: string) => Promise<unknown> };
    };
  }

  private async enqueueInternal(track: ResolvedTrack, position?: number) {
    if (this.queue.length >= appConfig.maxQueueSize) {
      throw new Error(`Queue limit reached (${appConfig.maxQueueSize} tracks).`);
    }

    await this.deleteQueueEmptyMessage();

    if (typeof position === "number" && position >= 0 && position < this.queue.length) {
      this.queue.splice(position, 0, track);
    } else {
      this.queue.push(track);
    }

    await this.persist();
    await this.maybeContinuePlaybackChain();
    this.scheduleNextTrackWarmup();
  }

  private formatRequester(track: ResolvedTrack) {
    if (track.requestedBy === "Autoplay") {
      return "Autoplay";
    }

    return track.requestedBy || "Unknown listener";
  }

  async removeTracksByRequester(userId: string) {
    return this.runExclusive(async () => {
      const before = this.queue.length;
      const filtered = this.queue.filter((track) => track.requestedById !== userId);
      this.queue.splice(0, this.queue.length, ...filtered);

      let removed = before - filtered.length;
      const removeCurrent = this.current?.requestedById === userId;

      await this.persist();
      this.scheduleNextTrackWarmup();

      if (removeCurrent) {
        removed += 1;
        await this.skipCurrentTrack();
      }

      return removed;
    });
  }

  private async skipCurrentTrack(): Promise<PlaybackControlResult> {
    const skipped = this.current;
    if (!skipped && !this.lavalinkPlayer?.track && this.queue.length === 0) {
      throw new Error("Nothing is playing right now.");
    }

    if (this.lavalinkPlayer?.track) {
      this.ignoreNextStoppedEvent = true;
      await this.lavalinkPlayer.stopTrack().catch((error) => {
        this.ignoreNextStoppedEvent = false;
        throw error;
      });
    }

    if (this.current || this.queue.length > 0) {
      await this.advancePlaybackChain({ recordCurrent: false, allowAutoplay: false });
    }

    return { track: skipped, next: this.current, snapshot: this.snapshot() };
  }

  private async maybeContinuePlaybackChain() {
    if (this.current || this.isAdvancing) {
      return;
    }

    await this.advancePlaybackChain();
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operationChain.then(operation, operation);
    this.operationChain = task.then(() => undefined, () => undefined);
    return task;
  }
}
