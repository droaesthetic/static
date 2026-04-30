import { fetch } from "undici";

interface LyricsLookupTarget {
  query: string;
  title?: string;
  artist?: string;
  durationInSeconds?: number;
}

export interface LyricsResult {
  title: string;
  artist?: string;
  lyrics: string;
  source: "lrclib" | "lyrics.ovh";
}

interface LrcLibEntry {
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string;
  syncedLyrics?: string;
}

export class LyricsService {
  async lookup(target: LyricsLookupTarget): Promise<LyricsResult> {
    const lrclibResult = await this.lookupFromLrcLib(target);
    if (lrclibResult) {
      return lrclibResult;
    }

    const lyricsOvhResult = await this.lookupFromLyricsOvh(target);
    if (lyricsOvhResult) {
      return lyricsOvhResult;
    }

    throw new Error("I couldn't find lyrics for that song.");
  }

  buildTarget(input: { query?: string; title?: string; artist?: string; durationInSeconds?: number }) {
    const normalizedQuery = input.query?.trim();
    const normalizedTitle = this.cleanTrackTitle(input.title);
    const normalizedArtist = input.artist?.trim();
    const combinedQuery = normalizedQuery || [normalizedArtist, normalizedTitle].filter(Boolean).join(" - ").trim();

    if (!combinedQuery) {
      throw new Error("Provide a song name, or play something first and use `/lyrics` with no query.");
    }

    return {
      query: combinedQuery,
      title: normalizedTitle,
      artist: normalizedArtist,
      durationInSeconds: input.durationInSeconds
    };
  }

  private async lookupFromLrcLib(target: LyricsLookupTarget): Promise<LyricsResult | null> {
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(target.query)}`;
    const response = await fetch(url, {
      headers: {
        "user-agent": "DroTunesBot/0.1 (+lyrics resolver)"
      }
    });

    if (!response.ok) {
      return null;
    }

    const entries = (await response.json().catch(() => [])) as LrcLibEntry[];
    if (!Array.isArray(entries) || !entries.length) {
      return null;
    }

    const [bestMatch] = entries
      .map((entry) => ({
        entry,
        score: this.scoreEntry(entry, target)
      }))
      .sort((left, right) => right.score - left.score);

    if (!bestMatch) {
      return null;
    }

    if (bestMatch.entry.instrumental) {
      throw new Error("That track appears to be instrumental, so there aren't lyrics to display.");
    }

    const lyrics = bestMatch.entry.plainLyrics?.trim()
      || this.stripSyncedTimestamps(bestMatch.entry.syncedLyrics)?.trim();

    if (!lyrics) {
      return null;
    }

    return {
      title: bestMatch.entry.trackName ?? target.title ?? "Unknown title",
      artist: bestMatch.entry.artistName ?? target.artist,
      lyrics,
      source: "lrclib"
    };
  }

  private async lookupFromLyricsOvh(target: LyricsLookupTarget): Promise<LyricsResult | null> {
    if (!target.title || !target.artist) {
      return null;
    }

    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(target.artist)}/${encodeURIComponent(target.title)}`;
    const response = await fetch(url, {
      headers: {
        "user-agent": "DroTunesBot/0.1 (+lyrics fallback)"
      }
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json().catch(() => null)) as { lyrics?: string } | null;
    const lyrics = payload?.lyrics?.trim();
    if (!lyrics) {
      return null;
    }

    return {
      title: target.title,
      artist: target.artist,
      lyrics,
      source: "lyrics.ovh"
    };
  }

  private scoreEntry(entry: LrcLibEntry, target: LyricsLookupTarget) {
    const normalizedEntryTitle = this.normalizeForMatch(entry.trackName);
    const normalizedEntryArtist = this.normalizeForMatch(entry.artistName);
    const normalizedTargetTitle = this.normalizeForMatch(target.title);
    const normalizedTargetArtist = this.normalizeForMatch(target.artist);
    const normalizedTargetQuery = this.normalizeForMatch(target.query);

    let score = 0;

    if (normalizedTargetTitle) {
      if (normalizedEntryTitle === normalizedTargetTitle) {
        score += 90;
      } else if (normalizedEntryTitle.includes(normalizedTargetTitle)) {
        score += 50;
      } else {
        score += Math.round(this.tokenOverlap(normalizedEntryTitle, normalizedTargetTitle) * 40);
      }
    } else {
      score += Math.round(this.tokenOverlap(normalizedEntryTitle, normalizedTargetQuery) * 32);
    }

    if (normalizedTargetArtist) {
      if (normalizedEntryArtist === normalizedTargetArtist) {
        score += 45;
      } else if (normalizedEntryArtist.includes(normalizedTargetArtist) || normalizedTargetArtist.includes(normalizedEntryArtist)) {
        score += 24;
      } else {
        score += Math.round(this.tokenOverlap(normalizedEntryArtist, normalizedTargetArtist) * 24);
      }
    }

    if (target.durationInSeconds && entry.duration) {
      const delta = Math.abs(target.durationInSeconds - entry.duration);
      if (delta <= 2) {
        score += 30;
      } else if (delta <= 5) {
        score += 24;
      } else if (delta <= 10) {
        score += 16;
      } else if (delta <= 20) {
        score += 8;
      } else if (delta >= 60) {
        score -= 18;
      }
    }

    if (entry.plainLyrics) {
      score += 6;
    }

    return score;
  }

  private stripSyncedTimestamps(value: string | undefined) {
    if (!value) {
      return undefined;
    }

    return value
      .split("\n")
      .map((line) => line.replace(/\[[^\]]+\]/g, "").trimEnd())
      .join("\n")
      .trim();
  }

  private cleanTrackTitle(value: string | undefined) {
    if (!value) {
      return undefined;
    }

    return value
      .replace(/\((?:official|audio|video|lyrics?|visualizer|sped up|slowed.*?|nightcore|8d|bass boosted)[^)]*\)/gi, "")
      .replace(/\[(?:official|audio|video|lyrics?|visualizer|sped up|slowed.*?|nightcore|8d|bass boosted)[^\]]*\]/gi, "")
      .replace(/\s*-\s*(?:official|audio|video|lyrics?|visualizer|sped up|slowed.*?|nightcore|8d|bass boosted).*$/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private tokenOverlap(left: string, right: string) {
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

  private normalizeForMatch(value: string | undefined) {
    return (value ?? "")
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/\[[^\]]*]/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}
