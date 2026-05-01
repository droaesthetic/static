import play from "play-dl";
import { randomUUID } from "node:crypto";
import { fetch } from "undici";
import { appConfig } from "../config.js";
import type { Provider, ResolvedTrack, SearchResult } from "../types.js";

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
  playbackProvider: "youtube" | "soundcloud";
  playbackUrl: string;
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

interface SpotifyPlaylistTrackMetadata {
  title: string;
  artists: string[];
  album?: string;
  artwork?: string;
  durationInSeconds?: number;
  url: string;
}

interface SpotifyPlaylistPage {
  total?: number;
  next?: string | null;
  items?: Array<{
    track?: {
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
    } | null;
  }>;
}

const providerMatchers: Array<{ provider: Provider; regex: RegExp }> = [
  { provider: "youtube", regex: /(?:youtube\.com|youtu\.be)/i },
  { provider: "soundcloud", regex: /soundcloud\.com/i },
  { provider: "spotify", regex: /spotify\.com/i },
  { provider: "deezer", regex: /deezer\.com/i },
  { provider: "apple_music", regex: /music\.apple\.com/i },
  { provider: "suno", regex: /suno\.com/i },
  { provider: "amazon_music", regex: /music\.amazon\./i }
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

const vevoRejectedMessage = "VEVO links are not supported by this bot. Try a non-VEVO YouTube upload, SoundCloud link, or search query instead.";

export class ProviderResolver {
  private soundCloudSearchEnabled = true;
  private spotifyAccessToken?: { value: string; expiresAt: number };

  async resolve({ query, requestedBy, requestedById }: ResolveOptions): Promise<ResolvedTrack> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error("Provide a song URL, search query, or uploaded audio file.");
    }

    const isUrl = /^https?:\/\//i.test(normalizedQuery);

    if (isUrl && this.isVevoUrl(normalizedQuery)) {
      this.rejectVevoLink();
    }

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
    const playback = await this.findPlayableAlternative({
      query: [metadata.artist, metadata.title].filter(Boolean).join(" - ") || normalizedQuery,
      title: metadata.title,
      artist: metadata.artist,
      artists: metadata.artists,
      album: metadata.album,
      durationInSeconds: metadata.durationInSeconds
    });

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
      id: randomUUID(),
      addedAt: new Date().toISOString()
    };
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error("Provide search terms for the song you want to find.");
    }

    const youtubeResults = await play.search(normalizedQuery, {
      limit,
      source: { youtube: "video" }
    });

    const results = youtubeResults
      .map((video) => {
        const url = this.buildYouTubePlaybackUrl(video.url, "id" in video ? video.id : undefined);
        if (!url) {
          return null;
        }

        if (this.isVevoMetadata({ title: video.title, artist: video.channel?.name, url })) {
          return null;
        }

        return {
          title: video.title ?? "Unknown title",
          artist: video.channel?.name,
          url,
          durationInSeconds: video.durationInSec,
          playbackProvider: "youtube" as const
        };
      })
      .filter((result): result is NonNullable<typeof result> => result !== null);

    if (results.length) {
      return results;
    }

    if (!this.soundCloudSearchEnabled) {
      return [];
    }

    try {
      const soundCloudResults = await play.search(normalizedQuery, {
        source: { soundcloud: "tracks" },
        limit
      });

      return soundCloudResults
        .filter((track) => Boolean(track.url))
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
    playlistUrl.searchParams.set(
      "fields",
      "name,tracks(total,next,items(track(type,name,duration_ms,external_urls,album(name,images),artists(name),is_playable)))"
    );

    const initial = await this.fetchSpotifyJson<{
      name?: string;
      tracks?: SpotifyPlaylistPage;
    }>(playlistUrl.toString(), token);

    const playlistName = initial.name || "Spotify Playlist";
    const totalTracks = initial.tracks?.total ?? 0;
    const metadata = await this.collectSpotifyPlaylistTracks(initial.tracks, token, maxTracks);

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

  detectProvider(query: string): Provider {
    for (const matcher of providerMatchers) {
      if (matcher.regex.test(query)) {
        return matcher.provider;
      }
    }

    return "search";
  }

  private async resolveSearch(query: string, requestedBy: string, requestedById: string): Promise<ResolvedTrack> {
    const playback = await this.findPlayableAlternative(query);
    return {
      ...playback,
      url: playback.playbackUrl,
      requestedBy,
      requestedById,
      sourceProvider: "search",
      id: randomUUID(),
      addedAt: new Date().toISOString()
    };
  }

  private async resolveYouTube(url: string, requestedBy: string, requestedById: string): Promise<ResolvedTrack> {
    const video = await play.video_info(url);
    const title = video.video_details.title ?? "Unknown title";
    const artist = video.video_details.channel?.name;

    if (this.isVevoMetadata({ title, artist, url })) {
      this.rejectVevoLink();
    }

    return {
      id: randomUUID(),
      title,
      artist,
      url,
      artwork: video.video_details.thumbnails?.at(-1)?.url,
      durationInSeconds: Number(video.video_details.durationInSec) || undefined,
      requestedBy,
      requestedById,
      sourceProvider: "youtube",
      playbackProvider: "youtube",
      playbackUrl: url,
      addedAt: new Date().toISOString()
    };
  }

  private async resolveSoundCloud(url: string, requestedBy: string, requestedById: string): Promise<ResolvedTrack> {
    const track = await play.soundcloud(url);
    return {
      id: randomUUID(),
      title: track.name,
      artist: track.user?.name,
      url,
      artwork: "thumbnail" in track ? track.thumbnail : undefined,
      durationInSeconds: track.durationInSec,
      requestedBy,
      requestedById,
      sourceProvider: "soundcloud",
      playbackProvider: "soundcloud",
      playbackUrl: url,
      addedAt: new Date().toISOString()
    };
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
    const searchQueries = this.buildPlaybackSearchQueries(target);
    const youtubeCandidates = new Map<string, PlaybackCandidate>();

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
        youtubeCandidates.set(candidate.playbackUrl.toLowerCase(), candidate);
      }
    }

    const rankedYouTubeResults = [...youtubeCandidates.values()]
      .map((video) => ({
        ...video,
        score: this.scoreCandidate(video, target)
      }))
      .sort((left, right) => right.score - left.score);

    if (rankedYouTubeResults.length) {
      const [bestVideo] = rankedYouTubeResults;
      return {
        title: bestVideo.title,
        artist: bestVideo.artist,
        artwork: bestVideo.artwork,
        durationInSeconds: bestVideo.durationInSeconds,
        playbackProvider: bestVideo.playbackProvider,
        playbackUrl: bestVideo.playbackUrl
      };
    }

    let rankedSoundCloudResults: Array<PlaybackCandidate & { score: number }> = [];
    if (this.soundCloudSearchEnabled) {
      const soundCloudCandidates = new Map<string, PlaybackCandidate>();

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
          soundCloudCandidates.set(candidate.playbackUrl.toLowerCase(), candidate);
        }
      }

      rankedSoundCloudResults = [...soundCloudCandidates.values()]
        .map((track) => ({
          ...track,
          score: this.scoreCandidate(track, target)
        }))
        .sort((left, right) => right.score - left.score);
    }

    const [first] = rankedSoundCloudResults;
    if (!first) {
      throw new Error("No playable match found for that link.");
    }

    return {
      title: first.title,
      artist: first.artist,
      artwork: first.artwork,
      durationInSeconds: first.durationInSeconds,
      playbackProvider: "soundcloud" as const,
      playbackUrl: first.playbackUrl
    };
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

    const rankedCandidates = [...candidateMap.values()]
      .map((candidate) => ({
        candidate,
        score: this.scoreAutoplayCandidate(candidate, seedTrack)
      }))
      .sort((left, right) => right.score - left.score);

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

  private async collectPlaybackCandidates(query: string, limit: number): Promise<PlaybackCandidate[]> {
    const youtubeResults = await play.search(query, {
      limit,
      source: { youtube: "video" }
    });

    const youtubeCandidates = youtubeResults
      .map((video) => {
        const playbackUrl = this.buildYouTubePlaybackUrl(video.url, "id" in video ? video.id : undefined);
        if (!playbackUrl) {
          return null;
        }

        if (this.isVevoMetadata({ title: video.title, artist: video.channel?.name, url: playbackUrl })) {
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
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

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

    return [...youtubeCandidates, ...soundCloudCandidates];
  }

  private async collectYouTubeCandidates(query: string, limit: number): Promise<PlaybackCandidate[]> {
    const youtubeResults = await play.search(query, {
      limit,
      source: { youtube: "video" }
    });

    return youtubeResults
      .map((video) => {
        const playbackUrl = this.buildYouTubePlaybackUrl(video.url, "id" in video ? video.id : undefined);
        if (!playbackUrl) {
          return null;
        }

        if (this.isVevoMetadata({ title: video.title, artist: video.channel?.name, url: playbackUrl })) {
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
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
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
        const track = item.track;
        if (!track || track.type !== "track" || !track.name || track.is_playable === false) {
          continue;
        }

        const artists = track.artists?.map((artist) => artist.name).filter((name): name is string => Boolean(name)) ?? [];
        if (!artists.length) {
          continue;
        }

        tracks.push({
          title: track.name,
          artists,
          album: track.album?.name,
          artwork: track.album?.images?.[0]?.url,
          durationInSeconds: track.duration_ms ? Math.floor(track.duration_ms / 1000) : undefined,
          url: track.external_urls?.spotify ?? ""
        });

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

  private async resolveSpotifyPlaylistTrack(
    track: SpotifyPlaylistTrackMetadata,
    requestedBy: string,
    requestedById: string
  ): Promise<ResolvedTrack> {
    const [artist] = track.artists;
    const playback = await this.findPlayableAlternative({
      query: [artist, track.title].filter(Boolean).join(" - "),
      title: track.title,
      artist,
      artists: track.artists,
      album: track.album,
      durationInSeconds: track.durationInSeconds
    });

    return {
      id: randomUUID(),
      title: track.title,
      artist,
      url: track.url || playback.playbackUrl,
      artwork: track.artwork ?? playback.artwork,
      durationInSeconds: track.durationInSeconds ?? playback.durationInSeconds,
      requestedBy,
      requestedById,
      sourceProvider: "spotify",
      playbackProvider: playback.playbackProvider,
      playbackUrl: playback.playbackUrl,
      addedAt: new Date().toISOString()
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
      throw new Error(`Spotify API request failed (${response.status}).`);
    }

    return await response.json() as T;
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
    if (!target.title && !target.artist && !target.durationInSeconds) {
      return 0;
    }

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
    for (const unwantedTerm of ["live", "remix", "cover", "karaoke", "instrumental", "sped up", "slowed", "nightcore", "reverb"]) {
      if (
        candidateDescriptorSource.includes(unwantedTerm)
        && !this.normalizeForMatch(target.title).includes(unwantedTerm)
        && !this.normalizeForMatch(target.query).includes(unwantedTerm)
      ) {
        score -= 20;
      }
    }

    const lowerCandidateTitle = candidate.title?.toLowerCase() ?? "";
    const lowerCandidateArtist = candidate.artist?.toLowerCase() ?? "";

    if (normalizedTargetArtist) {
      const channelMentionsArtist = normalizedCandidateArtist.includes(normalizedTargetArtist)
        || normalizedTargetArtist.includes(normalizedCandidateArtist);

      if (channelMentionsArtist && lowerCandidateArtist.includes("- topic")) {
        score += 24;
      } else if (channelMentionsArtist && /vevo|official/i.test(lowerCandidateArtist)) {
        score += 14;
      } else if (channelMentionsArtist) {
        score += 8;
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
      "lyrics",
      "lyric video",
      "visualizer",
      "fan made",
      "fanmade",
      "edit",
      "mashup",
      "slowed",
      "reverb",
      "sped up",
      "nightcore",
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

    for (const unwantedTerm of ["live", "remix", "cover", "karaoke", "instrumental", "sped up", "slowed", "nightcore", "reverb", "lyrics", "lyric", "visualizer", "fanmade", "fan made", "8d"]) {
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

    return this.uniqueValues([
      target.query.trim(),
      primaryArtist && title ? `${primaryArtist} - ${title}` : undefined,
      primaryArtist && title ? `${primaryArtist} ${title}` : undefined,
      primaryArtist && title ? `${title} ${primaryArtist}` : undefined,
      primaryArtist && title ? `${primaryArtist} ${title} official audio` : undefined,
      primaryArtist && title ? `${primaryArtist} ${title} topic` : undefined,
      primaryArtist && title && album ? `${primaryArtist} ${title} ${album}` : undefined,
      artists.length > 1 && title ? `${artists.join(" ")} ${title}` : undefined
    ].filter((query): query is string => Boolean(query)));
  }

  private parseSpotifyDescriptionParts(description: string | undefined) {
    const cleanedDescription = this.cleanProviderDecorations(description, "spotify");
    return cleanedDescription
      ?.replace(/^listen to\s+/i, "")
      .replace(/\s+on spotify\.?$/i, "")
      .split(/\s*[Â·•]\s*/)
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
      .replace(/\s*\|\s*Amazon Music.*$/i, "")
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

  private buildYouTubePlaybackUrl(url: string | undefined, id: string | undefined): string | undefined {
    return url ?? (id ? `https://www.youtube.com/watch?v=${id}` : undefined);
  }

  private rejectVevoLink(): never {
    throw new Error(vevoRejectedMessage);
  }

  private isVevoMetadata({ title, artist, url }: { title?: string; artist?: string; url?: string }) {
    return this.isVevoUrl(url) || this.isVevoChannelName(artist) || this.isVevoChannelName(title);
  }

  private isVevoChannelName(value: string | undefined) {
    if (!value) {
      return false;
    }

    const normalized = value.trim().toLowerCase().replace(/[\s._-]+/g, "");
    return normalized === "vevo" || normalized.endsWith("vevo");
  }

  private isVevoUrl(url: string | undefined) {
    if (!url) {
      return false;
    }

    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      if (hostname === "vevo.com" || hostname.endsWith(".vevo.com")) {
        return true;
      }

      if (!/(^|\.)youtube\.com$/i.test(hostname) && hostname !== "youtu.be") {
        return false;
      }

      return parsed.pathname
        .split("/")
        .filter(Boolean)
        .some((segment) => this.isVevoChannelName(decodeURIComponent(segment).replace(/^@/, "")));
    } catch {
      return /\bvevo\.com\b/i.test(url);
    }
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
