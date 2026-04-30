import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppState, GuildSettings, Playlist, StoredGuildPlayerState } from "../types.js";

const dataDir = path.resolve(process.cwd(), "data");
const statePath = path.join(dataDir, "state.json");

const defaultState: AppState = {
  guildSettings: {},
  guildPlayers: {},
  playlists: {}
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
      this.state = {
        ...defaultState,
        ...JSON.parse(raw)
      };
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

  getPlaylists(guildId: string): Playlist[] {
    return Object.values(this.state.playlists[guildId] ?? {}).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  getPlaylist(guildId: string, name: string): Playlist | undefined {
    return this.state.playlists[guildId]?.[name.toLowerCase()];
  }

  async setPlaylist(guildId: string, playlist: Playlist) {
    this.state.playlists[guildId] ??= {};
    this.state.playlists[guildId][playlist.name.toLowerCase()] = playlist;
    await this.flush();
  }

  async deletePlaylist(guildId: string, name: string) {
    delete this.state.playlists[guildId]?.[name.toLowerCase()];
    await this.flush();
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
