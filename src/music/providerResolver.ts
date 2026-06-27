import play from "play-dl";
import { randomUUID } from "node:crypto";
import { fetch, type Response as UndiciResponse } from "undici";
import { appConfig } from "../config.js";
import type { PlaybackProvider, Provider, ResolvedTrack, SearchResult } from "../types.js";

interface ResolveOptions {
  query: string;
  requestedBy: string;
  requestedById: string;
}

interface AutoplayResolveOptions {
  seedTrack: Pick<ResolvedTrack, "title" | "artist" | "playbackUrl" | "url" | "durationInSeconds">;
  recentTracks?: Array<Pick<ResolvedTrack, "title" | "artist" | "playbackUrl" | "url">>;
  requestedBy: string;
  requestedById: string;
}

interface ResolvedMetadata {
  title?: string;
  artist?: string;
  artists?: string[];
  album?: string;
  artwork?: string;
  durationInSeconds?: number;
}

interface PlaybackSearchTarget {
  query: string;
  title?: string;
  artist?: string;
  artists?: string[];
  album?: string;
  durationInSeconds?: number;
}

interface PlaybackCandidate {
  title: string;
  artist?: string;
  artwork?: string;
  durationInSeconds?: number;
  playbackProvider: Exclude<PlaybackProvider, "upload">;
  playbackUrl: string;
}

interface YouTubeVideoDetails {
  durationInSeconds: number | undefined;
  isMusic: boolean;
  title?: string;
  artist?: string;
  artwork?: string;
}

interface SoundCloudOEmbedResponse {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}

interface SpotifyOEmbedResponse {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}

interface SpotifyPlaylistResolveOptions {
  url: string;
  requestedBy: string;
  requestedById: string;
  maxTracks: number;
}

interface SpotifyPlaylistResolveResult {
  name: string;
  totalTracks: number;
  tracks: ResolvedTrack[];
}

interface SpotifyPlaylistMetadataResult {
  name: string;
  totalTracks: number;
  tracks: SpotifyPlaylistTrackMetadata[];
}

interface SpotifyPlaylistTrackMetadata {
  title: string;
  artists: string[];
  album?: string;
  artwork?: string;
  durationInSeconds?: number;
  url: string;
}

interface SpotifyApiTrack {
  type?: string;
  name?: string;
  duration_ms?: number;
  is_playable?: boolean;
  external_urls?: { spotify?: string };
  album?: {
    name?: string;
    images?: Array<{ url?: string; height?: number; width?: number }>;
  };
  artists?: Array<{ name?: string }>;
}

interface SpotifySearchResponse {
  tracks?: {
    items?: SpotifyApiTrack[];
  };
}

interface SpotifyPlaylistPage {
  total?: number;
  next?: string | null;
  items?: Array<{
    item?: SpotifyApiTrack | null;
    track?: SpotifyApiTrack | null;
  }>;
}

interface SpotifyAlbumPage {
  total?: number;
  next?: string | null;
  items?: SpotifyApiTrack[];
}

interface SpotifyAlbumResponse {
  name?: string;
  total_tracks?: number;
  images?: Array<{ url?: string; height?: number; width?: number }>;
  tracks?: SpotifyAlbumPage;
}

interface YouTubeSearchResponse {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      channelTitle?: string;
      categoryId?: string;
      thumbnails?: Record<string, { url?: string }>;
    };
  }>;
}

interface YouTubeVideosResponse {
  items?: Array<{
    id?: string;
    snippet?: {
      categoryId?: string;
      channelTitle?: string;
      thumbnails?: Record<string, { url?: string }>;
      title?: string;
    };
    contentDetails?: { duration?: string };
  }>;
}

const providerMatchers: Array<{ provider: Provider; regex: RegExp }> = [
  { provider: "youtube", regex: /(?:music\.youtube|youtube\.com|youtu\.be)/i },
  { provider: "soundcloud", regex: /(?:soundcloud\.com|snd\.sc)/i },
  { provider: "spotify", regex: /(?:spotify\.com|spoti\.fi|spotify\.link)/i },
  { provider: "deezer", regex: /deezer\.com/i },
  { provider: "apple_music", regex: /music\.apple\.com/i },
  { provider: "suno", regex: /suno\.com/i },
  { provider: "amazon_music", regex: /(?:music\.amazon\.|amazon\.[^/]+\/music|amzn\.to\/)/i }
];

const directMediaExtensions = new Set([
  "mp3",
  "wav",
  "flac",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "webm",
  "mp4",
  "mov",
  "mkv"
]);

const youtubeMusicCategoryId = "10";

export class ProviderResolver {
  private soundCloudSearchEnabled = true;
  private spotifyAccessToken?: { value: string; expiresAt: number };

  async resolve({ query, requestedBy, requestedById }: ResolveOptions): Promise<ResolvedTrack> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error("Provide a song URL, search query, or uploaded audio file.");
    }

    const isUrl = /^https?:\/\//i.test(normalizedQuery);

    if (isUrl && this.isDirectMediaUrl(normalizedQuery)) {
      return this.resolveDirectMediaUrl(normalizedQuery, requestedBy, requestedById);
    }

    const provider = isUrl ? this.detectProvider(normalizedQuery) : "search";

    if (provider === "search") {
      return this.resolveSearch(normalizedQuery, requestedBy, requestedById);
    }

    if (provider === "youtube") {
      return this.resolveYouTube(normalizedQuery, requestedBy, requestedById);
    }

    if (provider === "soundcloud") {
      return this.resolveSoundCloud(normalizedQuery, requestedBy, requestedById);
    }

    const metadata = await this.resolveMetadataFromUrl(normalizedQuery, provider);
    if (provider === "spotify" && !metadata.title && !metadata.artist) {
      throw new Error("I could not read that Spotify track's title or artist, so I cannot safely match it to playable audio.");
    }

    const playbackTarget = {
      query: [metadata.artist, metadata.title].filter(Boolean).join(" - ") || normalizedQuery,
      title: metadata.title,
      artist: metadata.artist,
      artists: metadata.artists,
      album: metadata.album,
      durationInSeconds: metadata.durationInSeconds
    };
    const playback = this.buildSpotifyPlaybackCandidate(playbackTarget, normalizedQuery)
      ?? this.buildLavalinkSearchFallbackCandidate(playbackTarget)
      ?? await this.findPlayableAlternative(playbackTarget);

    return {
      title: metadata.title ?? playback.title ?? "Unknown title",
      artist: metadata.artist,
      url: normalizedQuery,
      artwork: metadata.artwork ?? playback.artwork,
      durationInSeconds: metadata.durationInSeconds ?? playback.durationInSeconds,
      requestedBy,
      requestedById,
      sourceProvider: provider,
      playbackProvider: playback.playbackProvider,
      playbackUrl: playback.playbackUrl,
      searchQuery: [metadata.artist, metadata.title].filter(Boolean).join(" ") || normalizedQuery,
      id: randomUUID(),
      addedAt: new Date().toISOString()
    };
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error("Provide search terms for the song you want to find.");
    }

    const searchTarget = this.parseTypedSongQuery(normalizedQuery);
    const results = (await this.collectRankedPlaybackCandidates(searchTarget))
      .slice(0, limit)
      .map((candidate) => ({
        title: candidate.title,
        artist: candidate.artist,
        url: candidate.playbackUrl,
        durationInSeconds: candidate.durationInSeconds,
        playbackProvider: candidate.playbackProvider
      }));

    if (results.length) {
      return results;
    }

    if (!this.soundCloudSearchEnabled) {
      return [];
    }

    try {
      const soundCloudResults = await play.search(normalizedQuery, {
        source: { soundcloud: "tracks" },
        limit: this.searchCandidateLimit(limit)
      });

      return soundCloudResults
        .filter((track) => Boolean(track.url))
        .slice(0, limit)
        .map((track) => ({
          title: track.name ?? "Unknown title",
          artist: track.user?.name,
          url: track.url,
          durationInSeconds: track.durationInSec,
          playbackProvider: "soundcloud" as const
        }));
    } catch (error) {
      this.handleSoundCloudSearchError("[resolver] SoundCloud search fallback unavailable", error);
      return [];
    }
  }

  async resolvePlaybackRetry(
    track: Pick<ResolvedTrack, "title" | "artist" | "artwork" | "durationInSeconds" | "playbackUrl" | "searchQuery">,
    failedPlaybackUrls: string[]
  ): Promise<Pick<ResolvedTrack, "title" | "artist" | "artwork" | "durationInSeconds" | "playbackProvider" | "playbackUrl"> | null> {
    const query = track.searchQuery ?? [track.artist, track.title].filter(Boolean).join(" ").trim();
    if (!query) {
      return null;
    }

    const excludedUrls = new Set(
      [track.playbackUrl, ...failedPlaybackUrls]
        .filter(Boolean)
        .map((url) => url.toLowerCase())
    );
    const rankedCandidates = await this.collectRankedPlaybackCandidates({
      query,
      title: track.title,
      artist: track.artist,
      durationInSeconds: track.durationInSeconds
    });
    const next = rankedCandidates.find((candidate) => !excludedUrls.has(candidate.playbackUrl.toLowerCase()));
    if (!next) {
      const fallback = this.buildLavalinkSearchFallbackCandidate({
        query,
        title: track.title,
        artist: track.artist,
        durationInSeconds: track.durationInSeconds
      });
      return fallback && !excludedUrls.has(fallback.playbackUrl.toLowerCase())
        ? fallback
        : null;
    }

    return {
      title: next.title,
      artist: next.artist,
      artwork: next.artwork ?? track.artwork,
      durationInSeconds: next.durationInSeconds,
      playbackProvider: next.playbackProvider,
      playbackUrl: next.playbackUrl
    };
  }

  async resolveAutoplay({ seedTrack, recentTracks = [], requestedBy, requestedById }: AutoplayResolveOptions): Promise<ResolvedTrack> {
    const playback = await this.findAutoplayAlternative(seedTrack, recentTracks);

    return {
      id: randomUUID(),
      title: playback.title,
      artist: playback.artist,
      url: playback.playbackUrl,
      artwork: playback.artwork,
      durationInSeconds: playback.durationInSeconds,
      requestedBy,
      requestedById,
      sourceProvider: "search",
      playbackProvider: playback.playbackProvider,
      playbackUrl: playback.playbackUrl,
      searchQuery: [playback.artist, playback.title].filter(Boolean).join(" ") || playback.title,
      addedAt: new Date().toISOString()
    };
  }

  async resolveSpotifyPlaylist({
    url,
    requestedBy,
    requestedById,
    maxTracks
  }: SpotifyPlaylistResolveOptions): Promise<SpotifyPlaylistResolveResult> {
    if (!appConfig.spotify) {
      throw new Error("Spotify playlist expansion needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your .env.");
    }

    if (maxTracks < 1) {
      throw new Error("The queue is full, so no playlist tracks can be added right now.");
    }

    const playlistId = this.readSpotifyPlaylistId(url);
    if (!playlistId) {
      throw new Error("That Spotify playlist link is not valid.");
    }

    const token = await this.getSpotifyAccessToken();
    const playlistUrl = new URL(`https://api.spotify.com/v1/playlists/${playlistId}`);
    playlistUrl.searchParams.set("market", "US");
    let playlistName = "Spotify Playlist";
    let totalTracks = 0;
    let metadata: SpotifyPlaylistTrackMetadata[] = [];

    try {
      const initial = await this.fetchSpotifyJson<{
        name?: string;
        items?: SpotifyPlaylistPage;
        tracks?: SpotifyPlaylistPage;
      }>(playlistUrl.toString(), token);

      const firstPage = initial.items ?? initial.tracks;
      playlistName = initial.name || playlistName;
      totalTracks = firstPage?.total ?? totalTracks;
      metadata = await this.collectSpotifyPlaylistTracks(firstPage, token, maxTracks);
    } catch (error) {
      console.warn(
        "[spotify:playlist] Web API playlist contents unavailable; using public page fallback",
        error instanceof Error ? error.message : error
      );
    }

    if (!metadata.length) {
      const fallback = await this.resolveSpotifyPlaylistFromPublicPage(url, token, maxTracks);
      playlistName = fallback.name;
      totalTracks = fallback.totalTracks;
      metadata = fallback.tracks;
    }

    const resolvedTracks: ResolvedTrack[] = [];
    for (let index = 0; index < metadata.length; index += 4) {
      const chunk = metadata.slice(index, index + 4);
      const results = await Promise.allSettled(
        chunk.map((track) => this.resolveSpotifyPlaylistTrack(track, requestedBy, requestedById))
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          resolvedTracks.push(result.value);
        } else {
          console.warn("[spotify:playlist] failed to resolve playlist track", result.reason);
        }
      }
    }

    if (!resolvedTracks.length) {
      throw new Error("I found that Spotify playlist, but none of its tracks could be matched to playable audio.");
    }

    return {
      name: playlistName,
      totalTracks,
      tracks: resolvedTracks
    };
  }

  async resolveSpotifyAlbum({
    url,
    requestedBy,
    requestedById,
    maxTracks
  }: SpotifyPlaylistResolveOptions): Promise<SpotifyPlaylistResolveResult> {
    if (!appConfig.spotify) {
      throw new Error("Spotify album expansion needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your .env.");
    }

    if (maxTracks < 1) {
      throw new Error("The queue is full, so no album tracks can be added right now.");
    }

    const albumId = this.readSpotifyAlbumId(url);
    if (!albumId) {
      throw new Error("That Spotify album link is not valid.");
    }

    const token = await this.getSpotifyAccessToken();
    const albumUrl = new URL(`https://api.spotify.com/v1/albums/${albumId}`);
    albumUrl.searchParams.set("market", "US");
    let albumName = "Spotify Album";
    let totalTracks = 0;
    let metadata: SpotifyPlaylistTrackMetadata[] = [];

    try {
      const album = await this.fetchSpotifyJson<SpotifyAlbumResponse>(albumUrl.toString(), token);
      albumName = album.name || albumName;
      totalTracks = album.total_tracks ?? album.tracks?.total ?? totalTracks;
      metadata = await this.collectSpotifyAlbumTracks(
        album.tracks,
        token,
        maxTracks,
        albumName,
        album.images?.[0]?.url
      );
    } catch (error) {
      console.warn(
        "[spotify:album] Web API album contents unavailable; using public page fallback",
        error instanceof Error ? error.message : error
      );
    }

    if (!metadata.length) {
      const fallback = await this.resolveSpotifyTracksFromPublicPage(url, token, maxTracks, "album", "Spotify Album");
      albumName = fallback.name;
      totalTracks = fallback.totalTracks;
      metadata = fallback.tracks;
    }

    const resolvedTracks: ResolvedTrack[] = [];
    for (let index = 0; index < metadata.length; index += 4) {
      const chunk = metadata.slice(index, index + 4);
      const results = await Promise.allSettled(
        chunk.map((track) => this.resolveSpotifyPlaylistTrack(track, requestedBy, requestedById))
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          resolvedTracks.push(result.value);
        } else {
          console.warn("[spotify:album] failed to resolve album track", result.reason);
        }
      }
    }

    if (!resolvedTracks.length) {
      throw new Error("I found that Spotify album, but none of its tracks could be matched to playable audio.");
    }

    return {
      name: albumName,
      totalTracks,
      tracks: resolvedTracks
    };
  }

  detectProvider(query: string): Provider {
    for (const matcher of providerMatchers) {
      if (matcher.regex.test(query)) {
        return matcher.provider;
      }
    }

    return "search";
  }

  private async resolveSearch(query: string, requestedBy: string, requestedById: string): Promise<ResolvedTrack> {
    const searchTarget = this.parseTypedSongQuery(query);
    const playback = await this.findPlayableAlternative(searchTarget);
    return {
      ...playback,
      url: playback.playbackUrl,
      requestedBy,
      requestedById,
      sourceProvider: "search",
      searchQuery: query,
      id: randomUUID(),
      addedAt: new Date().toISOString()
    };
  }

  private async resolveYouTube(url: string, requestedBy: string, requestedById: string): Promise<ResolvedTrack> {
    const video = await this.resolveYouTubeVideoInfo(url);
    await this.assertYouTubeMusicLink(url, video);
    const id = this.readYouTubeVideoId(url);
    const apiDetails = video ? undefined : await this.fetchSingleYouTubeVideoDetails(id);
    const title = video?.video_details.title ?? apiDetails?.title ?? "YouTube track";
    const artist = video?.video_details.channel?.name ?? apiDetails?.artist;
    const playbackUrl = this.buildYouTubePlaybackUrl(url, id) ?? url;

    return {
      id: randomUUID(),
      title,
      artist,
      url,
      artwork: video?.video_details.thumbnails?.at(-1)?.url ?? apiDetails?.artwork,
      durationInSeconds: Number(video?.video_details.durationInSec) || apiDetails?.durationInSeconds,
      requestedBy,
      requestedById,
      sourceProvider: "youtube",
      playbackProvider: "youtube",
      playbackUrl,
      searchQuery: [artist, title].filter(Boolean).join(" ") || title,
      addedAt: new Date().toISOString()
    };
  }

  private async resolveYouTubeVideoInfo(url: string) {
    try {
      return await play.video_info(url);
    } catch (error) {
      console.warn("[youtube] play-dl metadata lookup failed; deferring playback resolution to Lavalink.", error);
      return undefined;
    }
  }

  private async resolveSoundCloud(url: string, requestedBy: string, requestedById: string): Promise<ResolvedTrack> {
    const playbackUrl = await this.normalizeSoundCloudUrl(url);
    let metadata: ResolvedMetadata | undefined;

    try {
      const track = await play.soundcloud(playbackUrl);
      metadata = {
        title: track.name,
        artist: track.user?.name,
        artwork: "thumbnail" in track ? track.thumbnail : undefined,
        durationInSeconds: track.durationInSec
      };
    } catch (error) {
      if (this.isMissingSoundCloudClientError(error)) {
        console.warn("[soundcloud] play-dl metadata unavailable; using public page metadata fallback.");
      } else {
        console.warn("[soundcloud] play-dl metadata lookup failed; using public page metadata fallback.", error);
      }
      metadata = await this.resolveSoundCloudMetadataFromPublicPage(playbackUrl);
    }

    return {
      id: randomUUID(),
      title: metadata.title ?? this.readFilenameFromUrl(playbackUrl) ?? "SoundCloud track",
      artist: metadata.artist,
      url: playbackUrl,
      artwork: metadata.artwork,
      durationInSeconds: metadata.durationInSeconds,
      requestedBy,
      requestedById,
      sourceProvider: "soundcloud",
      playbackProvider: "soundcloud",
      playbackUrl,
      searchQuery: [metadata.artist, metadata.title].filter(Boolean).join(" ") || metadata.title,
      addedAt: new Date().toISOString()
    };
  }

  private async normalizeSoundCloudUrl(url: string) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (host !== "snd.sc" && host !== "on.soundcloud.com") {
        return url;
      }

      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "DroTunesBot/0.1 (+soundcloud resolver)"
        }
      });

      return response.url || url;
    } catch {
      return url;
    }
  }

  private async resolveSoundCloudMetadataFromPublicPage(url: string): Promise<ResolvedMetadata> {
    const oEmbed = await this.resolveSoundCloudOEmbed(url);
    if (oEmbed.title || oEmbed.author_name || oEmbed.thumbnail_url) {
      return {
        title: oEmbed.title,
        artist: oEmbed.author_name,
        artwork: oEmbed.thumbnail_url
      };
    }

    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "DroTunesBot/0.1 (+soundcloud resolver)"
        }
      });

      if (!response.ok) {
        return {};
      }

      const html = await response.text();
      const title = this.readMeta(html, "og:title") ?? this.readMeta(html, "twitter:title") ?? this.readTitleTag(html);
      const artist = this.readMeta(html, "twitter:audio:artist_name")
        ?? this.readMeta(html, "soundcloud:user")
        ?? this.guessArtist(title);
      const artwork = this.readMeta(html, "og:image") ?? this.readMeta(html, "twitter:image");

      return {
        title: this.cleanProviderDecorations(title, "soundcloud"),
        artist,
        artwork
      };
    } catch {
      return {};
    }
  }

  private async resolveSoundCloudOEmbed(url: string): Promise<SoundCloudOEmbedResponse> {
    try {
      const oEmbedUrl = new URL("https://soundcloud.com/oembed");
      oEmbedUrl.searchParams.set("format", "json");
      oEmbedUrl.searchParams.set("url", url);

      const response = await fetch(oEmbedUrl, {
        headers: {
          accept: "application/json",
          "user-agent": "DroTunesBot/0.1 (+soundcloud resolver)"
        }
      });

      if (!response.ok) {
        return {};
      }

      return await response.json() as SoundCloudOEmbedResponse;
    } catch {
      return {};
    }
  }

  private resolveDirectMediaUrl(url: string, requestedBy: string, requestedById: string): ResolvedTrack {
    return {
      id: randomUUID(),
      title: this.readFilenameFromUrl(url) ?? "Uploaded file",
      url,
      requestedBy,
      requestedById,
      sourceProvider: "upload",
      playbackProvider: "upload",
      playbackUrl: url,
      addedAt: new Date().toISOString()
    };
  }

  private async resolveMetadataFromUrl(url: string, provider: Provider): Promise<ResolvedMetadata> {
    if (provider === "spotify" && appConfig.spotify) {
      try {
        return await this.resolveSpotifyMetadataFromApi(url);
      } catch (error) {
        console.warn(
          "[spotify] Web API track metadata unavailable; using public page fallback",
          error instanceof Error ? error.message : error
        );
      }
    }

    if (provider === "spotify") {
      const metadata = await this.resolveSpotifyMetadataFromOEmbed(url);
      if (metadata.title || metadata.artist || metadata.artwork) {
        return metadata;
      }
    }

    const response = await fetch(url, {
      headers: {
        "user-agent": "DroTunesBot/0.1 (+dashboard resolver)"
      }
    });

    const html = await response.text();
    const titleTag = this.readTitleTag(html);
    const title = this.readMeta(html, "og:title") ?? this.readMeta(html, "twitter:title") ?? titleTag;
    const description = this.readMeta(html, "og:description")
      ?? this.readMeta(html, "twitter:description")
      ?? this.readMeta(html, "description");
    const artwork = this.readMeta(html, "og:image");
    const durationText = this.readMeta(html, "music:duration");
    const durationInSeconds = durationText ? Number(durationText) || undefined : undefined;

    if (provider === "spotify") {
      return this.resolveSpotifyMetadataFromHtml(html, title, titleTag, description, artwork, durationInSeconds);
    }

    if (provider === "apple_music") {
      return this.resolveAppleMusicMetadataFromHtml(title, titleTag, description, artwork, durationInSeconds);
    }

    if (provider === "amazon_music") {
      return this.resolveAmazonMusicMetadataFromHtml(title, titleTag, description, artwork, durationInSeconds);
    }

    return {
      title: this.cleanProviderDecorations(title, provider),
      artist: this.guessArtist(title),
      artwork,
      durationInSeconds
    };
  }

  private async findPlayableAlternative(target: string | PlaybackSearchTarget) {
    const normalizedTarget = typeof target === "string"
      ? { query: target }
      : target;

    return this.findPlayableAlternativeFromQueries(normalizedTarget);
  }

  private async findPlayableAlternativeFromQueries(target: PlaybackSearchTarget) {
    const rankedResults = await this.collectRankedPlaybackCandidates(target);
    if (rankedResults.length) {
      const [bestVideo] = rankedResults;
      return {
        title: bestVideo.title,
        artist: bestVideo.artist,
        artwork: bestVideo.artwork,
        durationInSeconds: bestVideo.durationInSeconds,
        playbackProvider: bestVideo.playbackProvider,
        playbackUrl: bestVideo.playbackUrl
      };
    }

    const lavalinkSearchFallback = this.buildLavalinkSearchFallbackCandidate(target);
    if (!lavalinkSearchFallback) {
      throw new Error("No playable match found for that link.");
    }

    console.warn(
      `[resolver] falling back to Lavalink YouTube Music search for "${lavalinkSearchFallback.searchQuery}"`
    );
    return lavalinkSearchFallback;
  }

  private async collectRankedPlaybackCandidates(
    target: PlaybackSearchTarget,
    provider?: Exclude<PlaybackProvider, "upload">
  ): Promise<Array<PlaybackCandidate & { score: number }>> {
    const searchQueries = this.buildPlaybackSearchQueries(target);
    const candidates = new Map<string, PlaybackCandidate>();

    if ((!provider || provider === "spotify") && appConfig.spotify) {
      const spotifyResults = await Promise.allSettled(
        searchQueries.map((query) =>
          this.withTimeout(
            this.collectSpotifyCandidates(query, 10),
            12000,
            `Spotify candidate search timed out for query: ${query}`
          )
        )
      );

      for (const result of spotifyResults) {
        if (result.status !== "fulfilled") {
          console.warn("[resolver] Spotify candidate query failed", result.reason);
          continue;
        }

        for (const candidate of result.value) {
          candidates.set(candidate.playbackUrl.toLowerCase(), candidate);
        }
      }
    }

    if ((!provider || provider === "soundcloud") && this.soundCloudSearchEnabled) {
      const soundCloudResults = await Promise.allSettled(
        searchQueries.slice(0, 3).map((query) =>
          this.withTimeout(
            this.collectSoundCloudCandidates(query, 5),
            12000,
            `SoundCloud candidate search timed out for query: ${query}`
          )
        )
      );

      for (const result of soundCloudResults) {
        if (result.status !== "fulfilled") {
          this.handleSoundCloudSearchError("[resolver] SoundCloud playback fallback unavailable", result.reason);
          continue;
        }

        for (const candidate of result.value) {
          candidates.set(candidate.playbackUrl.toLowerCase(), candidate);
        }
      }
    }

    if (!provider || provider === "youtube") {
      const youtubeResults = await Promise.allSettled(
        searchQueries.map((query) =>
          this.withTimeout(
            this.collectYouTubeCandidates(query, 10),
            12000,
            `YouTube candidate search timed out for query: ${query}`
          )
        )
      );

      for (const result of youtubeResults) {
        if (result.status !== "fulfilled") {
          console.warn("[resolver] YouTube candidate query failed", result.reason);
          continue;
        }

        for (const candidate of result.value) {
          candidates.set(candidate.playbackUrl.toLowerCase(), candidate);
        }
      }
    }

    const filteredCandidates = this.filterUnrequestedEditCandidates([...candidates.values()], target);

    return filteredCandidates
      .map((candidate) => ({
        ...candidate,
        score: this.scoreCandidate(candidate, target)
      }))
      .sort((left, right) =>
        this.playbackProviderPriority(right.playbackProvider) - this.playbackProviderPriority(left.playbackProvider)
        || right.score - left.score
      );
  }

  private buildLavalinkSearchFallbackCandidate(target: PlaybackSearchTarget) {
    const query = this.buildLavalinkSearchFallbackQuery(target);
    if (!query) {
      return null;
    }

    return {
      title: target.title ?? query,
      artist: target.artist,
      artwork: undefined,
      durationInSeconds: target.durationInSeconds,
      playbackProvider: "youtube" as const,
      playbackUrl: `ytmsearch:${query}`,
      searchQuery: query
    };
  }

  private buildLavalinkSearchFallbackQuery(target: PlaybackSearchTarget) {
    const title = target.title?.trim();
    const artist = target.artist?.trim() ?? target.artists?.[0]?.trim();
    const cleanedQuery = this.cleanTypedSongQuery(target.query);

    if (artist && title) {
      return `${artist} - ${title}`;
    }

    return cleanedQuery || target.query.trim();
  }

  private playbackProviderPriority(provider: Exclude<PlaybackProvider, "upload">) {
    switch (provider) {
      case "spotify":
        return 3;
      case "soundcloud":
        return 2;
      case "youtube":
      default:
        return 1;
    }
  }

  private async findAutoplayAlternative(
    seedTrack: Pick<ResolvedTrack, "title" | "artist" | "playbackUrl" | "url" | "durationInSeconds">,
    recentTracks: Array<Pick<ResolvedTrack, "title" | "artist" | "playbackUrl" | "url">>
  ): Promise<PlaybackCandidate> {
    const seedArtist = seedTrack.artist?.trim() || this.guessArtist(seedTrack.title)?.trim();
    const seedTitle = this.cleanAutoplayTitle(seedTrack.title);
    const searchQueries = [
      seedArtist ? `${seedArtist} topic` : undefined,
      seedArtist ? `${seedArtist} official audio` : undefined,
      seedArtist ? seedArtist : undefined,
      seedArtist ? `${seedArtist} songs` : undefined,
      seedArtist ? `${seedArtist} top songs` : undefined,
      seedTitle ? `${seedTitle} official audio` : undefined
    ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

    const recentUrlSet = new Set(
      [seedTrack.playbackUrl, seedTrack.url, ...recentTracks.flatMap((track) => [track.playbackUrl, track.url])]
        .filter(Boolean)
        .map((value) => value.toLowerCase())
    );
    const recentSignatureSet = new Set(
      [seedTrack, ...recentTracks].map((track) => this.buildTrackSignature(track.title, track.artist)).filter(Boolean)
    );

    const candidateMap = new Map<string, PlaybackCandidate>();

    const candidateResults = await Promise.allSettled(
      searchQueries.map((query) => this.withTimeout(
        this.collectPlaybackCandidates(query, 12),
        8000,
        `Autoplay search timed out for query: ${query}`
      ))
    );

    candidateResults.forEach((result) => {
      if (result.status !== "fulfilled") {
        console.warn("[resolver] autoplay candidate query failed", result.reason);
        return;
      }

      for (const candidate of result.value) {
        const key = candidate.playbackUrl.toLowerCase();
        if (!candidateMap.has(key)) {
          candidateMap.set(key, candidate);
        }
      }
    });

    const rankedCandidates = this.filterUnrequestedEditCandidates([...candidateMap.values()])
      .map((candidate) => ({
        candidate,
        score: this.scoreAutoplayCandidate(candidate, seedTrack)
      }))
      .sort((left, right) =>
        this.playbackProviderPriority(right.candidate.playbackProvider) - this.playbackProviderPriority(left.candidate.playbackProvider)
        || right.score - left.score
      );

    const strictCandidates = rankedCandidates
      .filter(({ candidate }) => !recentUrlSet.has(candidate.playbackUrl.toLowerCase()))
      .filter(({ candidate }) => !this.isSameTrack(candidate, seedTrack))
      .filter(({ candidate }) => !recentSignatureSet.has(this.buildTrackSignature(candidate.title, candidate.artist)));

    const [strictMatch] = strictCandidates;
    if (strictMatch) {
      return strictMatch.candidate;
    }

    const noRepeatCandidates = rankedCandidates
      .filter(({ candidate }) => !recentUrlSet.has(candidate.playbackUrl.toLowerCase()))
      .filter(({ candidate }) => !this.isSameTrack(candidate, seedTrack));

    const [noRepeatMatch] = noRepeatCandidates;
    if (noRepeatMatch) {
      return noRepeatMatch.candidate;
    }

    const sameArtistFallback = rankedCandidates.filter(({ candidate, score }) => {
      if (this.isSameTrack(candidate, seedTrack)) {
        return false;
      }

      const normalizedSeedArtist = this.normalizeForMatch(seedArtist);
      const normalizedCandidateArtist = this.normalizeForMatch(candidate.artist);
      return Boolean(
        normalizedSeedArtist
        && normalizedCandidateArtist
        && (
          normalizedCandidateArtist.includes(normalizedSeedArtist)
          || normalizedSeedArtist.includes(normalizedCandidateArtist)
        )
        && score > 0
      );
    });

    const [sameArtistMatch] = sameArtistFallback;
    if (sameArtistMatch) {
      return sameArtistMatch.candidate;
    }

    throw new Error("Autoplay could not find a related follow-up track.");
  }

  private async collectYouTubeDataApiCandidates(query: string, limit: number): Promise<PlaybackCandidate[]> {
    if (!appConfig.youtubeApiKey) {
      return [];
    }

    const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    searchUrl.searchParams.set("part", "snippet");
    searchUrl.searchParams.set("type", "video");
    searchUrl.searchParams.set("videoCategoryId", youtubeMusicCategoryId);
    searchUrl.searchParams.set("maxResults", String(this.searchCandidateLimit(limit)));
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("key", appConfig.youtubeApiKey);

    const searchResponse = await fetch(searchUrl);
    if (!searchResponse.ok) {
      throw new Error(`YouTube Data API search failed (${searchResponse.status}).`);
    }

    const searchJson = await searchResponse.json() as YouTubeSearchResponse;
    const videos = (searchJson.items ?? [])
      .map((item) => {
        const id = item.id?.videoId;
        if (!id) {
          return null;
        }

        const playbackUrl = this.buildYouTubePlaybackUrl(undefined, id);
        if (!playbackUrl) {
          return null;
        }

        return {
          id,
          title: item.snippet?.title ?? "Unknown title",
          artist: item.snippet?.channelTitle,
          artwork: this.pickBestYouTubeThumbnail(item.snippet?.thumbnails),
          playbackProvider: "youtube" as const,
          playbackUrl
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

    const details = await this.fetchYouTubeVideoDetails(videos.map((video) => video.id));

    return videos
      .filter((candidate) => !this.isLikelyNonSongYouTubeResult(candidate.title, candidate.artist))
      .filter(({ id }) => details.get(id)?.isMusic !== false)
      .map(({ id, ...candidate }) => ({
        ...candidate,
        durationInSeconds: details.get(id)?.durationInSeconds
      }))
      .sort((left, right) => this.scoreQueryOnlyCandidate(right, query) - this.scoreQueryOnlyCandidate(left, query))
      .slice(0, limit);
  }

  private async collectPlayDlYouTubeCandidates(query: string, limit: number): Promise<PlaybackCandidate[]> {
    const youtubeResults = await play.search(query, {
      limit: this.searchCandidateLimit(limit),
      source: { youtube: "video" }
    });

    return youtubeResults
      .map((video) => {
        const playbackUrl = this.buildYouTubePlaybackUrl(video.url, "id" in video ? video.id : undefined);
        if (!playbackUrl) {
          return null;
        }

        if (this.isLikelyNonSongYouTubeResult(video.title, video.channel?.name)) {
          return null;
        }

        return {
          title: video.title ?? "Unknown title",
          artist: video.channel?.name,
          artwork: video.thumbnails?.at(-1)?.url,
          durationInSeconds: video.durationInSec,
          playbackProvider: "youtube" as const,
          playbackUrl
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((left, right) => this.scoreQueryOnlyCandidate(right, query) - this.scoreQueryOnlyCandidate(left, query))
      .slice(0, limit);
  }

  private async collectPlaybackCandidates(query: string, limit: number): Promise<PlaybackCandidate[]> {
    const spotifyCandidates = appConfig.spotify
      ? await this.collectSpotifyCandidates(query, limit).catch((error) => {
        console.warn("[resolver] Spotify autoplay candidates unavailable", error);
        return [];
      })
      : [];

    let soundCloudCandidates: PlaybackCandidate[] = [];
    if (this.soundCloudSearchEnabled) {
      try {
      const soundCloudResults = await play.search(query, {
        source: { soundcloud: "tracks" },
        limit
      });

      soundCloudCandidates = soundCloudResults
        .filter((track) => Boolean(track.url))
        .map((track) => ({
          title: track.name ?? "Unknown title",
          artist: track.user?.name,
          artwork: track.thumbnail,
          durationInSeconds: track.durationInSec,
          playbackProvider: "soundcloud" as const,
          playbackUrl: track.url
        }));
      } catch (error) {
        this.handleSoundCloudSearchError("[resolver] SoundCloud autoplay candidates unavailable", error);
      }
    }

    const youtubeCandidates = await this.collectYouTubeCandidates(query, limit);

    return [...spotifyCandidates, ...soundCloudCandidates, ...youtubeCandidates];
  }

  private async collectSpotifyCandidates(query: string, limit: number): Promise<PlaybackCandidate[]> {
    if (!appConfig.spotify) {
      return [];
    }

    const spotifyQuery = this.buildSpotifySearchQuery(query);
    if (!spotifyQuery) {
      return [];
    }

    const token = await this.getSpotifyAccessToken();
    const searchUrl = new URL("https://api.spotify.com/v1/search");
    searchUrl.searchParams.set("type", "track");
    searchUrl.searchParams.set("market", "US");
    searchUrl.searchParams.set("limit", String(this.searchCandidateLimit(limit)));
    searchUrl.searchParams.set("q", spotifyQuery);

    const result = await this.fetchSpotifyJson<SpotifySearchResponse>(searchUrl.toString(), token);
    return (result.tracks?.items ?? [])
      .map((track) => this.spotifyTrackToMetadata(track))
      .filter((track): track is SpotifyPlaylistTrackMetadata => Boolean(track))
      .map((track) => ({
        title: track.title,
        artist: track.artists[0],
        artwork: track.artwork,
        durationInSeconds: track.durationInSeconds,
        playbackProvider: "spotify" as const,
        playbackUrl: track.url
      }))
      .filter((candidate) => Boolean(candidate.playbackUrl))
      .slice(0, limit);
  }

  private async collectYouTubeCandidates(query: string, limit: number): Promise<PlaybackCandidate[]> {
    if (appConfig.youtubeApiKey) {
      try {
        const apiCandidates = await this.collectYouTubeDataApiCandidates(query, limit);
        if (apiCandidates.length) {
          return apiCandidates;
        }
      } catch (error) {
        console.warn("[resolver] YouTube Data API search unavailable; falling back to play-dl", error);
      }
    }

    return this.collectPlayDlYouTubeCandidates(query, limit);
  }

  private async collectSoundCloudCandidates(query: string, limit: number): Promise<PlaybackCandidate[]> {
    const soundCloudResults = await play.search(query, {
      source: { soundcloud: "tracks" },
      limit
    });

    return soundCloudResults
      .filter((track) => Boolean(track.url))
      .map((track) => ({
        title: track.name ?? "Unknown title",
        artist: track.user?.name,
        artwork: track.thumbnail,
        durationInSeconds: track.durationInSec,
        playbackProvider: "soundcloud" as const,
        playbackUrl: track.url
      }));
  }

  private async collectSpotifyPlaylistTracks(
    firstPage: SpotifyPlaylistPage | undefined,
    token: string,
    maxTracks: number
  ): Promise<SpotifyPlaylistTrackMetadata[]> {
    const tracks: SpotifyPlaylistTrackMetadata[] = [];
    let page = firstPage;
    let next = page?.next ?? null;

    while (page && tracks.length < maxTracks) {
      for (const item of page.items ?? []) {
        const metadata = this.spotifyTrackToMetadata(item.track ?? item.item);
        if (!metadata) {
          continue;
        }

        tracks.push(metadata);

        if (tracks.length >= maxTracks) {
          break;
        }
      }

      if (!next || tracks.length >= maxTracks) {
        break;
      }

      page = await this.fetchSpotifyJson<SpotifyPlaylistPage>(next, token);
      next = page.next ?? null;
    }

    return tracks;
  }

  private async collectSpotifyAlbumTracks(
    firstPage: SpotifyAlbumPage | undefined,
    token: string,
    maxTracks: number,
    albumName?: string,
    albumArtwork?: string
  ): Promise<SpotifyPlaylistTrackMetadata[]> {
    const tracks: SpotifyPlaylistTrackMetadata[] = [];
    let page = firstPage;
    let next = page?.next ?? null;

    while (page && tracks.length < maxTracks) {
      for (const item of page.items ?? []) {
        const metadata = this.spotifyTrackToMetadata(item, { album: albumName, artwork: albumArtwork });
        if (!metadata) {
          continue;
        }

        tracks.push(metadata);

        if (tracks.length >= maxTracks) {
          break;
        }
      }

      if (!next || tracks.length >= maxTracks) {
        break;
      }

      page = await this.fetchSpotifyJson<SpotifyAlbumPage>(next, token);
      next = page.next ?? null;
    }

    return tracks;
  }

  private async resolveSpotifyPlaylistFromPublicPage(
    url: string,
    token: string,
    maxTracks: number
  ): Promise<SpotifyPlaylistMetadataResult> {
    return this.resolveSpotifyTracksFromPublicPage(url, token, maxTracks, "playlist", "Spotify Playlist");
  }

  private async resolveSpotifyTracksFromPublicPage(
    url: string,
    token: string,
    maxTracks: number,
    collectionLabel: "album" | "playlist",
    fallbackName: string
  ): Promise<SpotifyPlaylistMetadataResult> {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      throw new Error(`Spotify ${collectionLabel} page could not be loaded (${response.status}).`);
    }

    const html = await response.text();
    const collectionName = this.cleanProviderDecorations(
      this.readMeta(html, "og:title") ?? this.readMeta(html, "twitter:title") ?? this.readTitleTag(html),
      "spotify"
    ) ?? fallbackName;
    const allTrackIds = this.readSpotifyTrackIdsFromHtml(html);
    const trackIds = allTrackIds.slice(0, maxTracks);

    if (!trackIds.length) {
      throw new Error(`I found that Spotify ${collectionLabel}, but Spotify did not expose any public tracks for the bot to queue.`);
    }

    const tracks: SpotifyPlaylistTrackMetadata[] = [];
    for (let index = 0; index < trackIds.length; index += 5) {
      const chunk = trackIds.slice(index, index + 5);
      const results = await Promise.allSettled(
        chunk.map((trackId) => this.fetchSpotifyTrack(trackId, token))
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          tracks.push(result.value);
        } else if (result.status === "rejected") {
          console.warn(`[spotify:${collectionLabel}] failed to load track metadata from public page fallback`, result.reason);
        }
      }
    }

    if (!tracks.length) {
      throw new Error(`I found that Spotify ${collectionLabel}, but none of its public tracks could be loaded from Spotify.`);
    }

    return {
      name: collectionName,
      totalTracks: allTrackIds.length,
      tracks
    };
  }

  private readSpotifyTrackIdsFromHtml(html: string) {
    const ids = new Set<string>();
    const patterns = [
      /spotify:track:([A-Za-z0-9]{22})/g,
      /spotify%3Atrack%3A([A-Za-z0-9]{22})/g
    ];

    for (const pattern of patterns) {
      for (const match of html.matchAll(pattern)) {
        if (match[1]) {
          ids.add(match[1]);
        }
      }
    }

    return [...ids];
  }

  private async fetchSpotifyTrack(trackId: string, token: string) {
    const trackUrl = new URL(`https://api.spotify.com/v1/tracks/${trackId}`);
    trackUrl.searchParams.set("market", "US");
    const track = await this.fetchSpotifyJson<SpotifyApiTrack>(trackUrl.toString(), token);
    return this.spotifyTrackToMetadata(track);
  }

  private async resolveSpotifyMetadataFromApi(url: string): Promise<ResolvedMetadata> {
    const trackId = this.readSpotifyTrackId(url);
    if (!trackId) {
      throw new Error("That Spotify track link is not valid.");
    }

    const token = await this.getSpotifyAccessToken();
    const track = await this.fetchSpotifyTrack(trackId, token);
    if (!track) {
      throw new Error("Spotify did not return playable track metadata.");
    }

    return {
      title: track.title,
      artist: track.artists[0],
      artists: track.artists,
      album: track.album,
      artwork: track.artwork,
      durationInSeconds: track.durationInSeconds
    };
  }

  private async resolveSpotifyMetadataFromOEmbed(url: string): Promise<ResolvedMetadata> {
    try {
      const oEmbedUrl = new URL("https://open.spotify.com/oembed");
      oEmbedUrl.searchParams.set("url", url);

      const response = await fetch(oEmbedUrl, {
        headers: {
          accept: "application/json",
          "user-agent": "DroTunesBot/0.1 (+spotify resolver)"
        }
      });

      if (!response.ok) {
        return {};
      }

      const data = await response.json() as SpotifyOEmbedResponse;
      const title = this.cleanProviderDecorations(data.title, "spotify");
      const artists = this.parseArtistList(data.author_name);

      return {
        title,
        artist: artists[0],
        artists,
        artwork: data.thumbnail_url
      };
    } catch {
      return {};
    }
  }

  private spotifyTrackToMetadata(
    track: SpotifyApiTrack | null | undefined,
    fallback?: { album?: string; artwork?: string }
  ): SpotifyPlaylistTrackMetadata | undefined {
    if (!track || track.type !== "track" || !track.name || track.is_playable === false) {
      return undefined;
    }

    const artists = track.artists?.map((artist) => artist.name).filter((name): name is string => Boolean(name)) ?? [];
    if (!artists.length) {
      return undefined;
    }

    return {
      title: track.name,
      artists,
      album: track.album?.name ?? fallback?.album,
      artwork: track.album?.images?.[0]?.url ?? fallback?.artwork,
      durationInSeconds: track.duration_ms ? Math.floor(track.duration_ms / 1000) : undefined,
      url: track.external_urls?.spotify ?? ""
    };
  }

  private async resolveSpotifyPlaylistTrack(
    track: SpotifyPlaylistTrackMetadata,
    requestedBy: string,
    requestedById: string
  ): Promise<ResolvedTrack> {
    const [artist] = track.artists;
    const playbackSearch = [artist, track.title].filter(Boolean).join(" - ") || track.title;
    const playbackTarget = {
      query: playbackSearch,
      title: track.title,
      artist,
      artists: track.artists,
      album: track.album,
      durationInSeconds: track.durationInSeconds
    };
    const playback = this.buildSpotifyPlaybackCandidate(playbackTarget, track.url)
      ?? this.buildLavalinkSearchFallbackCandidate(playbackTarget)
      ?? await this.findPlayableAlternative(playbackTarget);

    return {
      id: randomUUID(),
      title: track.title,
      artist,
      url: track.url || `https://open.spotify.com/search/${encodeURIComponent(playbackSearch)}`,
      artwork: track.artwork ?? playback.artwork,
      durationInSeconds: track.durationInSeconds ?? playback.durationInSeconds,
      requestedBy,
      requestedById,
      sourceProvider: "spotify",
      playbackProvider: playback.playbackProvider,
      playbackUrl: playback.playbackUrl,
      searchQuery: playbackSearch,
      addedAt: new Date().toISOString()
    };
  }

  private buildSpotifyPlaybackCandidate(target: PlaybackSearchTarget, url: string | undefined) {
    if (!appConfig.spotify || !url) {
      return null;
    }

    const trackId = this.readSpotifyTrackId(url);
    if (!trackId) {
      return null;
    }

    return {
      title: target.title ?? target.query,
      artist: target.artist ?? target.artists?.[0],
      artwork: undefined,
      durationInSeconds: target.durationInSeconds,
      playbackProvider: "spotify" as const,
      playbackUrl: `https://open.spotify.com/track/${trackId}`,
      searchQuery: this.buildLavalinkSearchFallbackQuery(target)
    };
  }

  private async getSpotifyAccessToken() {
    if (!appConfig.spotify) {
      throw new Error("Spotify API credentials are not configured.");
    }

    const now = Date.now();
    if (this.spotifyAccessToken && this.spotifyAccessToken.expiresAt > now + 60_000) {
      return this.spotifyAccessToken.value;
    }

    const credentials = Buffer.from(`${appConfig.spotify.clientId}:${appConfig.spotify.clientSecret}`).toString("base64");
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        authorization: `Basic ${credentials}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });

    if (!response.ok) {
      throw new Error(`Spotify rejected the configured API credentials (${response.status}).`);
    }

    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new Error("Spotify did not return an access token.");
    }

    this.spotifyAccessToken = {
      value: data.access_token,
      expiresAt: now + (data.expires_in ?? 3600) * 1000
    };
    return data.access_token;
  }

  private async fetchSpotifyJson<T>(url: string, token: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const details = await this.readSpotifyErrorDetails(response);
      throw new Error(`Spotify API request failed (${response.status})${details ? `: ${details}` : ""}.`);
    }

    return await response.json() as T;
  }

  private async readSpotifyErrorDetails(response: UndiciResponse) {
    const contentType = response.headers.get("content-type") ?? "";
    try {
      if (contentType.includes("application/json")) {
        const data = await response.json() as { error?: { message?: string; reason?: string } | string };
        if (typeof data.error === "string") {
          return data.error;
        }

        return [data.error?.message, data.error?.reason].filter(Boolean).join(" - ");
      }

      const text = await response.text();
      return text.trim().slice(0, 240);
    } catch {
      return "";
    }
  }

  private readSpotifyPlaylistId(url: string) {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/(?:intl-[^/]+\/)?playlist\/([A-Za-z0-9]+)/i);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private readSpotifyAlbumId(url: string) {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/(?:intl-[^/]+\/)?album\/([A-Za-z0-9]+)/i);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private readSpotifyTrackId(url: string) {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/(?:intl-[^/]+\/)?track\/([A-Za-z0-9]+)/i);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private resolveSpotifyMetadataFromHtml(
    html: string,
    rawTitle: string | undefined,
    titleTag: string | undefined,
    description: string | undefined,
    artwork: string | undefined,
    durationInSeconds: number | undefined
  ): ResolvedMetadata {
    const descriptionParts = this.parseSpotifyDescriptionParts(description);
    const musicianDescriptions = this.readMetaAll(html, "music:musician_description");
    const tagMatch = titleTag?.match(/^(.*?)\s*-\s*(?:song and lyrics by|song by)\s*(.*?)\s*\|\s*Spotify$/i);
    const cleanedTitle = this.cleanProviderDecorations(rawTitle ?? titleTag, "spotify");
    const title = tagMatch?.[1]?.trim() || cleanedTitle;
    const artists = this.extractSpotifyArtists(title, tagMatch?.[2], descriptionParts, musicianDescriptions, titleTag, rawTitle);

    return {
      title,
      artist: artists[0],
      artists,
      album: descriptionParts[1],
      artwork,
      durationInSeconds
    };
  }

  private resolveAppleMusicMetadataFromHtml(
    rawTitle: string | undefined,
    titleTag: string | undefined,
    description: string | undefined,
    artwork: string | undefined,
    durationInSeconds: number | undefined
  ): ResolvedMetadata {
    const cleanedTitle = this.cleanProviderDecorations(rawTitle ?? titleTag, "apple_music");
    const tagMatch = (titleTag ?? rawTitle)?.match(/^(.*?)\s+by\s+(.+?)\s+on Apple Music$/i);
    const rawDescription = this.cleanProviderDecorations(description, "apple_music");
    const descriptionParts = rawDescription
      ?.replace(/^listen to\s+/i, "")
      .split(/\s*[·•]\s*/)
      .map((part) => part.trim())
      .filter(Boolean)
      ?? [];
    const title = tagMatch?.[1]?.trim() ?? cleanedTitle;
    const artists = this.uniqueValues([
      ...(tagMatch?.[2] ? this.parseArtistList(tagMatch[2]) : []),
      ...this.extractAppleMusicArtistsFromDescription(title, descriptionParts)
    ]);

    return {
      title,
      artist: artists[0],
      artists,
      album: descriptionParts.find((part) =>
        this.normalizeForMatch(part) !== this.normalizeForMatch(title)
        && !artists.some((artist) => this.normalizeForMatch(artist) === this.normalizeForMatch(part))
      ),
      artwork,
      durationInSeconds
    };
  }

  private extractAppleMusicArtistsFromDescription(title: string | undefined, descriptionParts: string[]) {
    const normalizedTitle = this.normalizeForMatch(title);
    const artists: string[] = [];
    for (const part of descriptionParts) {
      const normalizedPart = this.normalizeForMatch(part);
      if (!normalizedPart || normalizedPart === normalizedTitle || /^\d{4}$/.test(part)) {
        continue;
      }

      if (!artists.length) {
        artists.push(...this.parseArtistList(part));
      }
    }

    return artists;
  }

  private resolveAmazonMusicMetadataFromHtml(
    rawTitle: string | undefined,
    titleTag: string | undefined,
    description: string | undefined,
    artwork: string | undefined,
    durationInSeconds: number | undefined
  ): ResolvedMetadata {
    const sourceTitle = rawTitle ?? titleTag;
    const cleanedTitle = this.cleanProviderDecorations(sourceTitle, "amazon_music");
    const byTitleMatch = sourceTitle?.match(/^(.*?)\s+by\s+(.+?)\s+(?:on|at)\s+Amazon Music/i);
    const dashTitleMatch = sourceTitle?.match(/^(.*?)\s+-\s+(.*?)\s*\|\s*Amazon Music/i);
    const rawDescription = this.cleanProviderDecorations(description, "amazon_music");
    const descriptionParts = this.parseAmazonMusicDescriptionParts(rawDescription);
    const title = byTitleMatch?.[1]?.trim()
      ?? dashTitleMatch?.[1]?.trim()
      ?? this.extractAmazonTitleFromDescription(descriptionParts)
      ?? cleanedTitle;
    const artists = this.uniqueValues([
      ...(byTitleMatch?.[2] ? this.parseArtistList(byTitleMatch[2]) : []),
      ...(dashTitleMatch?.[2] ? this.parseArtistList(dashTitleMatch[2]) : []),
      ...this.extractAmazonArtistsFromDescription(title, descriptionParts)
    ]);

    return {
      title,
      artist: artists[0],
      artists,
      album: this.extractAmazonAlbumFromDescription(title, artists, descriptionParts),
      artwork,
      durationInSeconds
    };
  }

  private parseAmazonMusicDescriptionParts(description: string | undefined) {
    if (!description) {
      return [];
    }

    return description
      .replace(/^listen to\s+/i, "")
      .replace(/\s+on Amazon Music(?: Unlimited)?\.?$/i, "")
      .split(/\s*[·•]\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  private extractAmazonTitleFromDescription(descriptionParts: string[]) {
    const [first] = descriptionParts;
    return first && !/^song|album|playlist$/i.test(first) ? first : undefined;
  }

  private extractAmazonArtistsFromDescription(title: string | undefined, descriptionParts: string[]) {
    const normalizedTitle = this.normalizeForMatch(title);
    const artists: string[] = [];

    for (const part of descriptionParts) {
      const normalizedPart = this.normalizeForMatch(part);
      if (!normalizedPart || normalizedPart === normalizedTitle || /^\d{4}$/.test(part)) {
        continue;
      }

      const explicitByMatch = part.match(/\bby\s+(.+)$/i);
      if (explicitByMatch?.[1]) {
        artists.push(...this.parseArtistList(explicitByMatch[1]));
        continue;
      }

      if (!artists.length && !/^song|album|playlist$/i.test(part)) {
        artists.push(...this.parseArtistList(part));
      }
    }

    return artists;
  }

  private extractAmazonAlbumFromDescription(title: string | undefined, artists: string[], descriptionParts: string[]) {
    const normalizedTitle = this.normalizeForMatch(title);
    const normalizedArtists = artists.map((artist) => this.normalizeForMatch(artist));

    return descriptionParts.find((part) => {
      const normalizedPart = this.normalizeForMatch(part);
      return normalizedPart
        && normalizedPart !== normalizedTitle
        && !normalizedArtists.includes(normalizedPart)
        && !/^song|album|playlist$/i.test(part)
        && !/^\d{4}$/.test(part);
    });
  }

  private extractSpotifyArtists(
    title: string | undefined,
    explicitArtist: string | undefined,
    descriptionParts: string[],
    musicianDescriptions: string[],
    titleTag: string | undefined,
    rawTitle: string | undefined
  ): string[] {
    if (explicitArtist) {
      return this.parseArtistList(explicitArtist);
    }

    if (musicianDescriptions.length) {
      const artists = musicianDescriptions.flatMap((entry) => this.parseArtistList(entry));
      if (artists.length) {
        return this.uniqueValues(artists);
      }
    }

    const byLineMatch = titleTag?.match(/song and lyrics by\s+(.+?)\s*\|\s*Spotify$/i)
      ?? rawTitle?.match(/song and lyrics by\s+(.+)$/i);
    if (byLineMatch?.[1]) {
      return this.parseArtistList(byLineMatch[1]);
    }

    if (descriptionParts.length) {
      const normalizedTitle = this.normalizeForMatch(title);
      const [first] = descriptionParts;
      if (first && this.normalizeForMatch(first) !== normalizedTitle) {
        return this.parseArtistList(first);
      }
    }

    const guessedArtist = this.guessArtist(rawTitle ?? titleTag);
    return guessedArtist ? this.parseArtistList(guessedArtist) : [];
  }

  private resolveSpotifyMetadata(
    rawTitle: string | undefined,
    titleTag: string | undefined,
    description: string | undefined,
    artwork: string | undefined,
    durationInSeconds: number | undefined
  ): ResolvedMetadata {
    const tagMatch = titleTag?.match(/^(.*?)\s*-\s*(?:song and lyrics by|song by)\s*(.*?)\s*\|\s*Spotify$/i);
    const cleanedTitle = this.cleanProviderDecorations(rawTitle ?? titleTag, "spotify");
    const title = tagMatch?.[1]?.trim() || cleanedTitle;
    const artist = this.extractSpotifyArtist(title, tagMatch?.[2], description, titleTag, rawTitle);

    return {
      title,
      artist,
      artwork,
      durationInSeconds
    };
  }

  private extractSpotifyArtist(
    title: string | undefined,
    explicitArtist: string | undefined,
    description: string | undefined,
    titleTag: string | undefined,
    rawTitle: string | undefined
  ): string | undefined {
    if (explicitArtist) {
      return explicitArtist.trim();
    }

    const byLineMatch = titleTag?.match(/song and lyrics by\s+(.+?)\s*\|\s*Spotify$/i)
      ?? rawTitle?.match(/song and lyrics by\s+(.+)$/i);
    if (byLineMatch?.[1]) {
      return byLineMatch[1].trim();
    }

    if (description) {
      const cleanedDescription = this.cleanProviderDecorations(description, "spotify");
      const dotParts = cleanedDescription
        ?.split(/\s*[·•]\s*/)
        .map((part) => part.trim())
        .filter(Boolean);

      if (dotParts?.length) {
        const normalizedTitle = this.normalizeForMatch(title);
        const first = dotParts[0];
        const second = dotParts[1];
        if (first && this.normalizeForMatch(first) !== normalizedTitle) {
          return first;
        }

        if (second && this.normalizeForMatch(second) !== normalizedTitle) {
          return second;
        }
      }
    }

    return this.guessArtist(rawTitle ?? titleTag);
  }

  private scoreCandidate(
    candidate: Pick<ResolvedTrack, "title" | "artist" | "durationInSeconds">,
    target: PlaybackSearchTarget
  ) {
    const normalizedCandidateTitle = this.normalizeForMatch(candidate.title);
    const normalizedCandidateArtist = this.normalizeForMatch(candidate.artist);
    const normalizedTargetTitle = this.normalizeForMatch(target.title);
    const normalizedTargetArtist = this.normalizeForMatch(target.artist);
    const normalizedTargetAlbum = this.normalizeForMatch(target.album);
    const targetArtists = this.uniqueValues([
      ...(target.artists ?? []),
      ...(target.artist ? [target.artist] : [])
    ].map((artist) => this.normalizeForMatch(artist)).filter(Boolean));

    let score = 0;

    if (normalizedTargetTitle) {
      if (normalizedCandidateTitle === normalizedTargetTitle) {
        score += 80;
      } else if (normalizedCandidateTitle.includes(normalizedTargetTitle)) {
        score += 45;
      } else {
        score += Math.round(this.tokenOverlap(normalizedCandidateTitle, normalizedTargetTitle) * 40);
      }
    }

    if (normalizedTargetArtist) {
      if (normalizedCandidateArtist === normalizedTargetArtist) {
        score += 35;
      } else if (
        normalizedCandidateArtist.includes(normalizedTargetArtist)
        || normalizedCandidateTitle.includes(normalizedTargetArtist)
      ) {
        score += 20;
      } else {
        score += Math.round(this.tokenOverlap(normalizedCandidateArtist, normalizedTargetArtist) * 18);
      }
    }

    if (targetArtists.length > 1) {
      const artistMatchCount = targetArtists.filter((artist) =>
        normalizedCandidateArtist.includes(artist) || normalizedCandidateTitle.includes(artist)
      ).length;
      score += artistMatchCount * 10;
    }

    const candidateDescriptorSource = `${normalizedCandidateTitle} ${normalizedCandidateArtist}`;
    score += this.versionPreferenceScore(candidateDescriptorSource, target.query, target.title);

    const lowerCandidateTitle = candidate.title?.toLowerCase() ?? "";
    const lowerCandidateArtist = candidate.artist?.toLowerCase() ?? "";

    if (!target.title && !target.artist && !target.durationInSeconds) {
      return this.scoreQueryOnlyCandidate(candidate, target.query);
    }

    if (normalizedTargetArtist) {
      const channelMentionsArtist = normalizedCandidateArtist.includes(normalizedTargetArtist)
        || normalizedTargetArtist.includes(normalizedCandidateArtist);
      const titleMentionsArtist = normalizedCandidateTitle.includes(normalizedTargetArtist);

      if (channelMentionsArtist && lowerCandidateArtist.includes("- topic")) {
        score += 24;
      } else if (channelMentionsArtist && /vevo|official/i.test(lowerCandidateArtist)) {
        score += 14;
      } else if (channelMentionsArtist) {
        score += 8;
      } else if (!titleMentionsArtist) {
        score -= 45;
      }
    }

    if (normalizedTargetAlbum && candidateDescriptorSource.includes(normalizedTargetAlbum)) {
      score += 6;
    }

    if (lowerCandidateTitle.includes("official audio")) {
      score += 18;
    } else if (lowerCandidateTitle.includes("official video")) {
      score += 8;
    } else if (lowerCandidateTitle.includes("audio") && !/lyric|lyrics|8d/.test(lowerCandidateTitle)) {
      score += 4;
    }

    const lyricPref = this.lyricVideoPreferenceBonus(lowerCandidateTitle, lowerCandidateArtist);
    score += lyricPref;
    score -= this.musicVideoPreferencePenalty(lowerCandidateTitle, lowerCandidateArtist, lyricPref > 0);
    score -= this.unrequestedLivePerformancePenalty(
      lowerCandidateTitle,
      lowerCandidateArtist,
      this.isLiveVersionRequested(target.query, target.title)
    );
    score -= this.nonSongYouTubeResultPenalty(
      lowerCandidateTitle,
      lowerCandidateArtist,
      [target.title, target.query].some((value) => this.isNonSongVariantRequested(value))
    );

    if (target.durationInSeconds && candidate.durationInSeconds) {
      const delta = Math.abs(target.durationInSeconds - candidate.durationInSeconds);
      if (delta <= 2) {
        score += 25;
      } else if (delta <= 5) {
        score += 20;
      } else if (delta <= 10) {
        score += 14;
      } else if (delta <= 20) {
        score += 8;
      } else if (delta >= 60) {
        score -= 18;
      }
    }

    const strongerUnwantedTerms = [
      "visualizer",
      "bass boosted",
      "8d",
      "amv"
    ];

    for (const unwantedTerm of strongerUnwantedTerms) {
      if (
        candidateDescriptorSource.includes(unwantedTerm)
        && !this.normalizeForMatch(target.title).includes(unwantedTerm)
        && !this.normalizeForMatch(target.query).includes(unwantedTerm)
      ) {
        score -= 28;
      }
    }

    return score;
  }

  /** Prefer uploads labeled as lyric / lyrics over plain music videos when search-matching. */
  private lyricVideoPreferenceBonus(lowerTitle: string, lowerArtist: string): number {
    const descriptor = `${lowerTitle} ${lowerArtist}`;
    if (/\blyric(?:al)?(?:\s+video)?\b/i.test(descriptor) || /\blyrics?\s+video\b/i.test(descriptor)) {
      return 48;
    }

    if (/\([^)]*\blyrics?\b[^)]*\)|\[[^\]]*\blyrics?\b[^\]]*\]/i.test(lowerTitle)) {
      return 40;
    }

    if (/\bwith\s+lyrics\b|\bsing[\s-]?along\b/i.test(descriptor)) {
      return 32;
    }

    if (/\blyrics\b/i.test(lowerTitle)) {
      return 22;
    }

    return 0;
  }

  private scoreQueryOnlyCandidate(candidate: Pick<ResolvedTrack, "title" | "artist">, query = ""): number {
    const normalizedQuery = this.normalizeForMatch(query);
    const normalizedCandidateTitle = this.normalizeForMatch(candidate.title);
    const normalizedCandidateArtist = this.normalizeForMatch(candidate.artist);
    const descriptor = `${normalizedCandidateTitle} ${normalizedCandidateArtist}`.trim();
    const lowerTitle = candidate.title?.toLowerCase() ?? "";
    const lowerArtist = candidate.artist?.toLowerCase() ?? "";
    const lyricPref = this.lyricVideoPreferenceBonus(lowerTitle, lowerArtist);
    let score = lyricPref
      + this.versionPreferenceScore(descriptor, query)
      - this.musicVideoPreferencePenalty(lowerTitle, lowerArtist, lyricPref > 0)
      - this.unrequestedLivePerformancePenalty(lowerTitle, lowerArtist, this.isLiveVersionRequested(query))
      - this.nonSongYouTubeResultPenalty(lowerTitle, lowerArtist, this.isNonSongVariantRequested(query));

    if (!normalizedQuery || !descriptor) {
      return score;
    }

    if (normalizedCandidateTitle === normalizedQuery) {
      score += 100;
    } else if (normalizedCandidateTitle.includes(normalizedQuery)) {
      score += 70;
    } else if (descriptor.includes(normalizedQuery)) {
      score += 55;
    }

    score += Math.round(this.tokenOverlap(normalizedCandidateTitle, normalizedQuery) * 70);
    score += Math.round(this.tokenOverlap(descriptor, normalizedQuery) * 35);

    return score;
  }

  private versionPreferenceScore(descriptor: string, ...requestedValues: Array<string | undefined>): number {
    const normalizedDescriptor = this.normalizeVersionText(descriptor);
    const normalizedRequest = this.normalizeVersionText(requestedValues.filter(Boolean).join(" "));
    const liveRequested = this.hasLiveVersionTerm(normalizedRequest);
    const variantRequested = this.hasAvoidedVersionTerm(normalizedRequest);
    const originalRequested = this.isOriginalVersionRequested(normalizedRequest);
    const hasLive = this.hasLiveVersionTerm(normalizedDescriptor);
    const hasAvoidedVariant = this.hasAvoidedVersionTerm(normalizedDescriptor);

    if (hasLive) {
      return liveRequested ? 35 : -180;
    }

    if (hasAvoidedVariant) {
      return variantRequested ? 35 : -90;
    }

    if (originalRequested) {
      return 14;
    }

    return 0;
  }

  private hasAvoidedVersionTerm(normalizedValue: string): boolean {
    return /\b(?:remix|re\s?mix|reimagined|rework|remake|cover|edit|flip|bootleg|mashup|slowed|reverb|sped\s+up|nightcore|acoustic|instrumental|orchestral|piano|lofi)\b/.test(normalizedValue);
  }

  private readRequestedVersionTerm(normalizedValue: string): string {
    return this.normalizeVersionText(normalizedValue).match(/\b(?:remix|re\s?mix|reimagined|rework|remake|cover|edit|flip|bootleg|mashup|slowed|reverb|sped\s+up|nightcore|acoustic|instrumental|orchestral|piano|lofi)\b/)?.[0] ?? "";
  }

  private isOriginalVersionRequested(normalizedValue: string): boolean {
    return /\b(?:original|official|studio|album\s+version|radio\s+edit|topic)\b/.test(normalizedValue);
  }

  private filterUnrequestedEditCandidates<T extends PlaybackCandidate>(candidates: T[], target?: PlaybackSearchTarget): T[] {
    const liveRequested = this.isLiveVersionRequested(target?.query, target?.title);
    const editRequested = this.isEditVersionRequested(target?.query, target?.title);
    let preferredCandidates = candidates;

    if (!liveRequested) {
      const nonLiveCandidates = preferredCandidates.filter((candidate) => !this.isLiveVersionCandidate(candidate));
      if (nonLiveCandidates.length) {
        preferredCandidates = nonLiveCandidates;
      }
    }

    if (!editRequested) {
      const nonEditCandidates = preferredCandidates.filter((candidate) => !this.isEditVersionCandidate(candidate));
      if (nonEditCandidates.length) {
        preferredCandidates = nonEditCandidates;
      }
    }

    return preferredCandidates;
  }

  private isLiveVersionRequested(...values: Array<string | undefined>): boolean {
    return values.some((value) => this.hasLiveVersionTerm(this.normalizeVersionText(value ?? "")));
  }

  private isLiveVersionCandidate(candidate: Pick<PlaybackCandidate, "title" | "artist">): boolean {
    return this.hasLiveVersionTerm(this.normalizeVersionText(`${candidate.title} ${candidate.artist ?? ""}`));
  }

  private hasLiveVersionTerm(normalizedValue: string): boolean {
    return /\blive\b/.test(normalizedValue)
      || /\b(?:concert|unplugged|tiny\s+desk|live\s+lounge|kexp|sessions?)\b/.test(normalizedValue);
  }

  private isEditVersionRequested(...values: Array<string | undefined>): boolean {
    return values.some((value) => /\bedit(?:s|ed)?\b/i.test(value ?? ""));
  }

  private isEditVersionCandidate(candidate: Pick<PlaybackCandidate, "title" | "artist">): boolean {
    return /\bedit(?:s|ed)?\b/i.test(`${candidate.title} ${candidate.artist ?? ""}`);
  }

  /** Down-rank obvious music-video titles when a lyric-style upload was not detected. */
  private musicVideoPreferencePenalty(lowerTitle: string, lowerArtist: string, looksLikeLyricUpload: boolean): number {
    if (looksLikeLyricUpload || /\blyric/i.test(`${lowerTitle} ${lowerArtist}`)) {
      return 0;
    }

    const descriptor = `${lowerTitle} ${lowerArtist}`;
    if (/\bofficial\s+music\s+video\b|\bmusic\s+video\b/i.test(descriptor)) {
      return 38;
    }

    if (/\bofficial\s+video\b/i.test(lowerTitle) && !/\blyric/i.test(descriptor)) {
      return 18;
    }

    if (/\bmv\b/i.test(lowerTitle)) {
      return 12;
    }

    return 0;
  }

  private unrequestedLivePerformancePenalty(lowerTitle: string, lowerArtist: string, liveRequested: boolean): number {
    if (liveRequested) {
      return 0;
    }

    const descriptor = `${lowerTitle} ${lowerArtist}`;
    if (/\s@\s/.test(lowerTitle)) {
      return 160;
    }

    if (/\b(?:full\s+set|live\s+set|concert|festival|soundboard|audience\s+recording)\b/i.test(descriptor)) {
      return 140;
    }

    if (/\b(?:at|from)\s+(?:the\s+)?[a-z0-9][a-z0-9'&.-]*(?:\s+[a-z0-9][a-z0-9'&.-]*){0,4}\s*,\s*[a-z]{2}\b/i.test(lowerTitle)) {
      return 120;
    }

    return 0;
  }

  private scoreAutoplayCandidate(
    candidate: PlaybackCandidate,
    seedTrack: Pick<ResolvedTrack, "title" | "artist" | "durationInSeconds">
  ) {
    const normalizedSeedTitle = this.normalizeForMatch(this.cleanAutoplayTitle(seedTrack.title));
    const normalizedSeedArtist = this.normalizeForMatch(seedTrack.artist);
    const normalizedCandidateTitle = this.normalizeForMatch(this.cleanAutoplayTitle(candidate.title));
    const normalizedCandidateArtist = this.normalizeForMatch(candidate.artist);
    const candidateDescriptorSource = `${normalizedCandidateTitle} ${normalizedCandidateArtist}`;

    let score = 0;

    if (normalizedSeedArtist) {
      if (normalizedCandidateArtist === normalizedSeedArtist) {
        score += 90;
      } else if (
        normalizedCandidateArtist.includes(normalizedSeedArtist)
        || normalizedSeedArtist.includes(normalizedCandidateArtist)
      ) {
        score += 55;
      } else {
        score += Math.round(this.tokenOverlap(normalizedCandidateArtist, normalizedSeedArtist) * 20);
      }
    }

    if (normalizedSeedTitle && normalizedCandidateTitle) {
      const titleOverlap = this.tokenOverlap(normalizedCandidateTitle, normalizedSeedTitle);
      if (titleOverlap > 0.6) {
        score -= 120;
      } else if (titleOverlap > 0.35) {
        score -= 35;
      }
    }

    if (candidateDescriptorSource.includes("- topic")) {
      score += 18;
    }

    if (/vevo|official/.test(candidateDescriptorSource)) {
      score += 10;
    }

    if (candidateDescriptorSource.includes("official audio")) {
      score += 20;
    } else if (candidateDescriptorSource.includes("official video")) {
      score += 8;
    }

    const lt = candidate.title?.toLowerCase() ?? "";
    const la = candidate.artist?.toLowerCase() ?? "";
    const lyricPref = this.lyricVideoPreferenceBonus(lt, la);
    score += lyricPref;
    score += this.versionPreferenceScore(candidateDescriptorSource);
    score -= this.musicVideoPreferencePenalty(lt, la, lyricPref > 0);
    score -= this.unrequestedLivePerformancePenalty(lt, la, false);
    score -= this.nonSongYouTubeResultPenalty(lt, la, false);

    for (const unwantedTerm of ["karaoke", "visualizer", "bass boosted", "8d"]) {
      if (candidateDescriptorSource.includes(unwantedTerm)) {
        score -= 22;
      }
    }

    if (seedTrack.durationInSeconds && candidate.durationInSeconds) {
      const delta = Math.abs(seedTrack.durationInSeconds - candidate.durationInSeconds);
      if (delta <= 10) {
        score += 12;
      } else if (delta <= 25) {
        score += 7;
      } else if (delta >= 90) {
        score -= 10;
      }
    }

    return score;
  }

  private tokenOverlap(left: string | undefined, right: string | undefined) {
    if (!left || !right) {
      return 0;
    }

    const leftTokens = new Set(left.split(" ").filter(Boolean));
    const rightTokens = new Set(right.split(" ").filter(Boolean));
    if (!leftTokens.size || !rightTokens.size) {
      return 0;
    }

    let matches = 0;
    for (const token of leftTokens) {
      if (rightTokens.has(token)) {
        matches += 1;
      }
    }

    return matches / Math.max(leftTokens.size, rightTokens.size);
  }

  private buildPlaybackSearchQueries(target: PlaybackSearchTarget) {
    const title = target.title?.trim();
    const artists = this.uniqueValues([
      ...(target.artists ?? []),
      ...(target.artist ? [target.artist] : [])
    ].map((artist) => artist.trim()).filter(Boolean));
    const primaryArtist = artists[0];
    const album = target.album?.trim();
    const cleanedQuery = this.cleanTypedSongQuery(target.query);

    return this.uniqueValues([
      target.query.trim(),
      cleanedQuery && cleanedQuery !== target.query.trim() ? cleanedQuery : undefined,
      primaryArtist && title ? `${primaryArtist} - ${title}` : undefined,
      primaryArtist && title ? `${primaryArtist} ${title}` : undefined,
      primaryArtist && title ? `${title} ${primaryArtist}` : undefined,
      primaryArtist && title ? `${primaryArtist} ${title} official audio` : undefined,
      primaryArtist && title ? `${primaryArtist} ${title} topic` : undefined,
      primaryArtist && title ? `${primaryArtist} ${title} lyrics` : undefined,
      primaryArtist && title && this.hasAvoidedVersionTerm(cleanedQuery) ? `${primaryArtist} ${title} ${this.readRequestedVersionTerm(cleanedQuery)}` : undefined,
      primaryArtist && title && album ? `${primaryArtist} ${title} ${album}` : undefined,
      artists.length > 1 && title ? `${artists.join(" ")} ${title}` : undefined,
      !title && cleanedQuery ? `${cleanedQuery} official audio` : undefined,
      !title && cleanedQuery ? `${cleanedQuery} lyrics` : undefined,
      !title && cleanedQuery ? `${cleanedQuery} topic` : undefined,
      !title && cleanedQuery && this.hasAvoidedVersionTerm(cleanedQuery) ? `${cleanedQuery} ${this.readRequestedVersionTerm(cleanedQuery)}` : undefined,
      ...(!title && cleanedQuery ? this.buildBareSongGuessQueries(cleanedQuery) : [])
    ].filter((query): query is string => Boolean(query)));
  }

  private buildBareSongGuessQueries(query: string) {
    const tokens = this.normalizeForMatch(query).split(" ").filter(Boolean);
    if (tokens.length < 3 || tokens.length > 8) {
      return [];
    }

    const guesses: string[] = [];
    const maxArtistTokens = Math.min(3, tokens.length - 2);
    for (let artistTokenCount = 1; artistTokenCount <= maxArtistTokens; artistTokenCount += 1) {
      const suffixArtist = tokens.slice(-artistTokenCount).join(" ");
      const suffixTitle = tokens.slice(0, -artistTokenCount).join(" ");
      guesses.push(
        `${suffixArtist} - ${suffixTitle}`,
        `${suffixArtist} ${suffixTitle} official audio`
      );

      const prefixArtist = tokens.slice(0, artistTokenCount).join(" ");
      const prefixTitle = tokens.slice(artistTokenCount).join(" ");
      guesses.push(
        `${prefixArtist} - ${prefixTitle}`,
        `${prefixArtist} ${prefixTitle} official audio`
      );
    }

    return guesses;
  }

  private buildSpotifySearchQuery(query: string) {
    const cleanedQuery = this.cleanTypedSongQuery(query)
      .replace(/[^\S\r\n]+/g, " ")
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .trim();

    if (!cleanedQuery) {
      return "";
    }

    return cleanedQuery
      .split(/\s+/)
      .filter((token) => !/^(?:album|artist|track|year|genre|isrc|upc):$/i.test(token))
      .join(" ")
      .trim();
  }

  private parseTypedSongQuery(query: string): PlaybackSearchTarget {
    const cleanedQuery = this.cleanTypedSongQuery(query);
    const dashMatch = cleanedQuery.match(/^(.+?)\s+(?:-|\u2013|\u2014|:)\s+(.+)$/);
    if (dashMatch?.[1] && dashMatch[2]) {
      const artist = this.cleanTypedSongQueryPart(dashMatch[1]);
      const title = this.cleanTypedSongQueryPart(dashMatch[2]);
      if (artist && title) {
        return { query, title, artist, artists: this.parseArtistList(artist) };
      }
    }

    const byMatch = cleanedQuery.match(/^(.+?)\s+by\s+(.+)$/i);
    if (byMatch?.[1] && byMatch[2]) {
      const title = this.cleanTypedSongQueryPart(byMatch[1]);
      const artist = this.cleanTypedSongQueryPart(byMatch[2]);
      if (artist && title) {
        return { query, title, artist, artists: this.parseArtistList(artist) };
      }
    }

    return { query: cleanedQuery || query };
  }

  private cleanTypedSongQuery(value: string | undefined) {
    return this.cleanTypedSongQueryPart(value)
      .replace(/\b(?:official\s+)?(?:music\s+video|lyric\s+video|audio|lyrics?)\b/gi, " ")
      .replace(/\s+(?:song|track)\s*$/i, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private cleanTypedSongQueryPart(value: string | undefined) {
    return (value ?? "")
      .replace(/^play\s+/i, "")
      .replace(/^search\s+(?:for\s+)?/i, "")
      .replace(/^find\s+/i, "")
      .replace(/\s*\((?:official\s+)?(?:music\s+video|video|audio|lyrics?|visualizer)\)\s*/gi, " ")
      .replace(/\s*\[(?:official\s+)?(?:music\s+video|video|audio|lyrics?|visualizer)]\s*/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private parseSpotifyDescriptionParts(description: string | undefined) {
    const cleanedDescription = this.cleanProviderDecorations(description, "spotify");
    return cleanedDescription
      ?.replace(/^listen to\s+/i, "")
      .replace(/\s+on spotify\.?$/i, "")
      .split(/\s*(?:\xB7|\u2022)\s*/)
      .map((part) => part.trim())
      .filter((part) => Boolean(part) && !/^song$/i.test(part) && !/^\d{4}$/.test(part))
      ?? [];
  }

  private parseArtistList(value: string | undefined) {
    if (!value) {
      return [];
    }

    return value
      .split(/\s*(?:,|&| x | X | feat\.?|ft\.?|featuring)\s*/i)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  private readMeta(html: string, property: string): string | undefined {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, "i"),
      new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, "i")
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return this.decodeEntities(match[1].trim());
      }
    }

    return undefined;
  }

  private readMetaAll(html: string, property: string): string[] {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, "gi"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, "gi"),
      new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, "gi")
    ];

    const values: string[] = [];
    for (const pattern of patterns) {
      const matches = html.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) {
          values.push(this.decodeEntities(match[1].trim()));
        }
      }
    }

    return this.uniqueValues(values);
  }

  private readTitleTag(html: string): string | undefined {
    const match = html.match(/<title>([^<]+)<\/title>/i);
    return match?.[1] ? this.decodeEntities(match[1].trim()) : undefined;
  }

  private cleanProviderDecorations(value: string | undefined, provider: Provider): string | undefined {
    if (!value) {
      return value;
    }

    const cleaned = value
      .replace(/\s*\|\s*Spotify.*$/i, "")
      .replace(/\s*\|\s*Deezer.*$/i, "")
      .replace(/\s*(?:\||on)\s*SoundCloud.*$/i, "")
      .replace(/\s*\|\s*Amazon Music.*$/i, "")
      .replace(/\s+(?:on|at)\s+Amazon Music(?: Unlimited)?\.?$/i, "")
      .replace(/\s*on Apple Music$/i, "")
      .replace(/\s*-\s*Suno$/i, "")
      .replace(/\s*-\s*YouTube$/i, "");

    if (provider === "suno") {
      return cleaned.replace(/^Listen to\s+/i, "");
    }

    return cleaned;
  }

  private guessArtist(title: string | undefined): string | undefined {
    if (!title) {
      return undefined;
    }

    const parts = title.split(" - ");
    return parts.length > 1 ? parts[0].trim() : undefined;
  }

  private normalizeForMatch(value: string | undefined): string {
    return (value ?? "")
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/\[[^\]]*]/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private normalizeVersionText(value: string | undefined): string {
    return (value ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private buildTrackSignature(title: string | undefined, artist: string | undefined) {
    const normalizedTitle = this.normalizeForMatch(this.cleanAutoplayTitle(title));
    const normalizedArtist = this.normalizeForMatch(artist);
    if (!normalizedTitle) {
      return "";
    }

    return `${normalizedArtist}::${normalizedTitle}`;
  }

  private cleanAutoplayTitle(value: string | undefined) {
    if (!value) {
      return "";
    }

    return value
      .replace(/\((?:official|audio|video|lyrics?|visualizer|sped up|slowed.*?|nightcore|8d|bass boosted|live|remix|cover)[^)]*\)/gi, "")
      .replace(/\[(?:official|audio|video|lyrics?|visualizer|sped up|slowed.*?|nightcore|8d|bass boosted|live|remix|cover)[^\]]*\]/gi, "")
      .replace(/\s*-\s*(?:official|audio|video|lyrics?|visualizer|sped up|slowed.*?|nightcore|8d|bass boosted|live|remix|cover).*$/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private isSameTrack(
    candidate: PlaybackCandidate,
    seedTrack: Pick<ResolvedTrack, "title" | "artist" | "playbackUrl" | "url">
  ) {
    const candidateUrl = candidate.playbackUrl.toLowerCase();
    const seedUrls = [seedTrack.playbackUrl, seedTrack.url].filter(Boolean).map((value) => value.toLowerCase());
    if (seedUrls.includes(candidateUrl)) {
      return true;
    }

    return this.buildTrackSignature(candidate.title, candidate.artist) === this.buildTrackSignature(seedTrack.title, seedTrack.artist);
  }

  private decodeEntities(value: string): string {
    return value
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  private uniqueValues(values: string[]) {
    return [...new Set(values.filter(Boolean))];
  }

  private isDirectMediaUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const extension = parsed.pathname.split(".").at(-1)?.toLowerCase();
      return Boolean(extension && directMediaExtensions.has(extension));
    } catch {
      return false;
    }
  }

  private async assertYouTubeMusicLink(url: string, video?: Awaited<ReturnType<typeof play.video_info>>) {
    const id = this.readYouTubeVideoId(url);
    if (!id) {
      throw new Error("That YouTube link is not a valid video link.");
    }

    if (this.isYouTubeMusicUrl(url) || this.isYouTubeShortShareUrl(url)) {
      return;
    }

    if (this.isYouTubeTopicVideo(video)) {
      return;
    }

    if (!appConfig.youtubeApiKey) {
      throw new Error("Only YouTube Music links or youtu.be share links are allowed. Use a music.youtube.com song link, a youtu.be share link, or configure YOUTUBE_API_KEY so the bot can verify Music-category YouTube videos.");
    }

    const details = await this.fetchYouTubeVideoDetails([id]);
    if (details.get(id)?.isMusic) {
      return;
    }

    throw new Error("That YouTube video is not marked as Music, so it cannot be queued. Use a YouTube Music song link instead.");
  }

  private isYouTubeTopicVideo(video: Awaited<ReturnType<typeof play.video_info>> | undefined) {
    const channelName = video?.video_details.channel?.name?.trim();
    return Boolean(channelName && /(?:^|\s)-\s*Topic$/i.test(channelName));
  }

  private isYouTubeMusicUrl(url: string) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      return host === "music.youtube" || host.startsWith("music.youtube.");
    } catch {
      return false;
    }
  }

  private isYouTubeShortShareUrl(url: string) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase() === "youtu.be" && Boolean(this.readYouTubeVideoId(url));
    } catch {
      return false;
    }
  }

  private readYouTubeVideoId(url: string): string | undefined {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (host === "youtu.be") {
        return parsed.pathname.split("/").filter(Boolean)[0];
      }

      if (host === "youtube.com" || host.endsWith(".youtube.com")) {
        if (parsed.pathname === "/watch" || parsed.pathname === "/music") {
          return parsed.searchParams.get("v") ?? undefined;
        }

        const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/?#]+)/i);
        if (shortsMatch?.[1]) {
          return shortsMatch[1];
        }
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private isLikelyNonSongYouTubeResult(title: string | undefined, artist: string | undefined) {
    return this.nonSongYouTubeResultPenalty(
      title?.toLowerCase() ?? "",
      artist?.toLowerCase() ?? "",
      false
    ) > 0;
  }

  private nonSongYouTubeResultPenalty(lowerTitle: string, lowerArtist: string, requestedNonSongVariant: boolean): number {
    if (requestedNonSongVariant) {
      return 0;
    }

    const descriptor = `${lowerTitle} ${lowerArtist}`;
    if (
      /\b(?:reacts?\s+to|reacting\s+to|first\s+time\s+(?:hearing|listening|watching)|(?:music\s+video|mv|song|album)\s+reaction|reaction\s+(?:to|video)|(?:song|album|music\s+video)\s+(?:review|breakdown|analysis))\b/i.test(descriptor)
      || /\b(?:music\s+video|mv|song|album)\s+reaction\b/i.test(descriptor)
      || /(?:\(|\[|\s+-\s+|\s+\|\s+)reaction(?:\)|\]|\s|$)/i.test(descriptor)
    ) {
      return 140;
    }

    return 0;
  }

  private isNonSongVariantRequested(value: string | undefined) {
    return /\b(?:reaction|reacts?|reacting|first\s+time\s+(?:hearing|listening|watching)|review|breakdown|analysis|commentary)\b/i.test(value ?? "");
  }

  private readFilenameFromUrl(url: string): string | undefined {
    try {
      const parsed = new URL(url);
      const encodedFilename = parsed.pathname.split("/").at(-1);
      if (!encodedFilename) {
        return undefined;
      }

      const filename = decodeURIComponent(encodedFilename)
        .replace(/\.[^.]+$/, "")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      return filename || undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchYouTubeVideoDetails(videoIds: string[]): Promise<Map<string, YouTubeVideoDetails>> {
    if (!appConfig.youtubeApiKey || !videoIds.length) {
      return new Map();
    }

    const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    videosUrl.searchParams.set("part", "snippet,contentDetails");
    videosUrl.searchParams.set("id", videoIds.join(","));
    videosUrl.searchParams.set("key", appConfig.youtubeApiKey);

    const response = await fetch(videosUrl);
    if (!response.ok) {
      console.warn(`[resolver] YouTube Data API video lookup failed (${response.status}).`);
      return new Map();
    }

    const json = await response.json() as YouTubeVideosResponse;
    return new Map(
      (json.items ?? [])
        .map((item) => {
          const duration = this.parseYouTubeDuration(item.contentDetails?.duration);
          const details: YouTubeVideoDetails = {
            durationInSeconds: duration,
            isMusic: item.snippet?.categoryId === youtubeMusicCategoryId,
            title: item.snippet?.title ? this.decodeEntities(item.snippet.title) : undefined,
            artist: item.snippet?.channelTitle,
            artwork: this.pickBestYouTubeThumbnail(item.snippet?.thumbnails)
          };
          return item.id
            ? [item.id, details] as const
            : null;
        })
        .filter((entry): entry is readonly [string, YouTubeVideoDetails] => entry !== null)
    );
  }

  private async fetchSingleYouTubeVideoDetails(videoId: string | undefined) {
    if (!videoId) {
      return undefined;
    }

    return (await this.fetchYouTubeVideoDetails([videoId])).get(videoId);
  }

  private parseYouTubeDuration(value: string | undefined): number | undefined {
    if (!value) {
      return undefined;
    }

    const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
    if (!match) {
      return undefined;
    }

    const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
    return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  }

  private pickBestYouTubeThumbnail(thumbnails: Record<string, { url?: string }> | undefined): string | undefined {
    return thumbnails?.maxres?.url
      ?? thumbnails?.standard?.url
      ?? thumbnails?.high?.url
      ?? thumbnails?.medium?.url
      ?? thumbnails?.default?.url;
  }

  private buildYouTubePlaybackUrl(url: string | undefined, id: string | undefined): string | undefined {
    const videoId = id ?? (url ? this.readYouTubeVideoId(url) : undefined);
    return videoId ? `https://music.youtube.com/watch?v=${videoId}` : url;
  }

  private searchCandidateLimit(limit: number) {
    return Math.min(Math.max(limit * 3, limit, 1), 25);
  }

  private handleSoundCloudSearchError(context: string, error: unknown) {
    if (this.isMissingSoundCloudClientError(error)) {
      if (this.soundCloudSearchEnabled) {
        console.warn(`${context}; disabling SoundCloud search because play-dl has no SoundCloud client ID configured.`);
      }
      this.soundCloudSearchEnabled = false;
      return;
    }

    console.warn(context, error);
  }

  private isMissingSoundCloudClientError(error: unknown) {
    if (!(error instanceof Error)) {
      return false;
    }

    return /client_id/i.test(error.message);
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }
}
