export type Provider =
  | "youtube"
  | "soundcloud"
  | "spotify"
  | "deezer"
  | "apple_music"
  | "suno"
  | "amazon_music"
  | "upload"
  | "search";

export type PlaybackProvider = "youtube" | "soundcloud" | "spotify" | "upload";

export type PermissionMode = "everyone" | "dj" | "admins";
export type FilterPreset = "off" | "bassboost" | "nightcore" | "vaporwave" | "karaoke" | "trebleboost" | "8d";
export type MemberPermissionOverride = "allow" | "deny";

export interface ChannelSettings {
  commandsEnabled?: boolean;
  botMessagesEnabled?: boolean;
}

export interface ResolvedTrack {
  id: string;
  title: string;
  artist?: string;
  url: string;
  artwork?: string;
  durationInSeconds?: number;
  requestedBy: string;
  requestedById: string;
  sourceProvider: Provider;
  playbackProvider: PlaybackProvider;
  playbackUrl: string;
  encodedTrack?: string;
  searchQuery?: string;
  failedPlaybackUrls?: string[];
  addedAt: string;
}

export interface GuildSettings {
  guildId: string;
  prefix: string;
  prefixes: string[];
  autoplay: boolean;
  voteSkipEnabled: boolean;
  removeAfterPlayed: boolean;
  permissionMode: PermissionMode;
  djRoleId?: string;
  disabledCommands: string[];
  channelSettings: Record<string, ChannelSettings>;
  memberPermissions: Record<string, MemberPermissionOverride>;
  privateResponsesPublic: boolean;
  autoDeleteBotResponses: boolean;
  maxSongLengthSeconds?: number;
  maxPlaylistLength?: number;
}

export interface SearchResult {
  title: string;
  artist?: string;
  url: string;
  durationInSeconds?: number;
  playbackProvider: Exclude<PlaybackProvider, "upload">;
}

export interface Playlist {
  name: string;
  tracks: ResolvedTrack[];
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceChannelHistoryEntry {
  id: string;
  guildId: string;
  memberId: string;
  memberName: string;
  action: "joined" | "left" | "moved";
  fromChannelId?: string;
  fromChannelName?: string;
  toChannelId?: string;
  toChannelName?: string;
  createdAt: string;
}

export interface PlaybackHistoryEntry {
  id: string;
  guildId: string;
  sessionId: string;
  sessionStartedAt: string;
  voiceChannelId?: string;
  voiceChannelName?: string;
  playedAt: string;
  track: ResolvedTrack;
}

export interface DashboardAuditLogEntry {
  id: string;
  guildId: string;
  action: string;
  settingKey: string;
  oldValue: string;
  newValue: string;
  createdAt: string;
}

export interface StoredGuildPlayerState {
  guildId: string;
  guildName: string;
  voiceChannelId?: string;
  textChannelId?: string;
  sessionId?: string;
  sessionStartedAt?: string;
  stayInVoiceEnabled?: boolean;
  stayInVoiceById?: string;
  soloSessionUserId?: string;
  volume: number;
  filterPreset?: FilterPreset;
  current?: ResolvedTrack;
  queue: ResolvedTrack[];
  history: ResolvedTrack[];
}

export interface QueueSnapshot {
  guildId: string;
  guildName: string;
  voiceChannelId?: string;
  voiceChannelName?: string;
  voiceChannelMemberCount?: number;
  textChannelId?: string;
  textChannelName?: string;
  sessionId?: string;
  sessionStartedAt?: string;
  stayInVoiceEnabled: boolean;
  stayInVoiceById?: string;
  soloSessionUserId?: string;
  isPlaying: boolean;
  isPaused: boolean;
  volume: number;
  filterPreset: FilterPreset;
  autoplay: boolean;
  voteSkipEnabled: boolean;
  removeAfterPlayed: boolean;
  permissionMode: PermissionMode;
  current?: ResolvedTrack;
  previous?: ResolvedTrack;
  played: ResolvedTrack[];
  upcoming: ResolvedTrack[];
  voiceHistory?: VoiceChannelHistoryEntry[];
}

export interface PremiumUserSettings {
  userId: string;
  personalPrefix?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionStatus?: string;
  currentPeriodEnd?: string;
  startedAt?: string;
  updatedAt: string;
}

export interface AppState {  
  guildSettings: Record<string, GuildSettings>;  
  guildPlayers: Record<string, StoredGuildPlayerState>;  
  playlists: Record<string, Record<string, Playlist>>;  
  voiceChannelHistory: Record<string, VoiceChannelHistoryEntry[]>;  
  settingsAuditLogs: Record<string, DashboardAuditLogEntry[]>;  
  songHistory: Record<string, PlaybackHistoryEntry[]>;  
  globalDeniedUserIds: string[];  
  premiumUsers: Record<string, PremiumUserSettings>;  
}
