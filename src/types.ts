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
  playbackProvider: "youtube" | "soundcloud" | "upload";
  playbackUrl: string;
  encodedTrack?: string;
  addedAt: string;
}

export interface GuildSettings {
  guildId: string;
  prefix: string;
  autoplay: boolean;
  voteSkipEnabled: boolean;
  preferAudioOnly: boolean;
  permissionMode: PermissionMode;
  djRoleId?: string;
  disabledCommands: string[];
  channelSettings: Record<string, ChannelSettings>;
  memberPermissions: Record<string, MemberPermissionOverride>;
  maxSongLengthSeconds?: number;
  maxPlaylistLength?: number;
}

export interface SearchResult {
  title: string;
  artist?: string;
  url: string;
  durationInSeconds?: number;
  playbackProvider: "youtube" | "soundcloud";
}

export interface Playlist {
  name: string;
  tracks: ResolvedTrack[];
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredGuildPlayerState {
  guildId: string;
  guildName: string;
  voiceChannelId?: string;
  textChannelId?: string;
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
  textChannelId?: string;
  isPlaying: boolean;
  isPaused: boolean;
  volume: number;
  filterPreset: FilterPreset;
  autoplay: boolean;
  voteSkipEnabled: boolean;
  permissionMode: PermissionMode;
  current?: ResolvedTrack;
  previous?: ResolvedTrack;
  upcoming: ResolvedTrack[];
}

export interface AppState {
  guildSettings: Record<string, GuildSettings>;
  guildPlayers: Record<string, StoredGuildPlayerState>;
  playlists: Record<string, Record<string, Playlist>>;
}
