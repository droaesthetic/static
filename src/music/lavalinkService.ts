import type { Client } from "discord.js";
import { Connectors, LoadType, Shoukaku, type NodeOption, type Player, type Track } from "shoukaku";
import { appConfig } from "../config.js";

export interface LavalinkPlaylist {
  name: string;
  selectedTrack: number;
  tracks: Track[];
}

export class LavalinkService {
  readonly manager?: Shoukaku;
  readonly enabled: boolean;

  constructor(client: Client) {
    this.enabled = Boolean(appConfig.lavalink);
    if (!appConfig.lavalink) {
      return;
    }

    const nodes: NodeOption[] = [{
      ...appConfig.lavalink,
      secure: false
    }];
    this.manager = new Shoukaku(new Connectors.DiscordJS(client), nodes, {
      resume: true,
      resumeTimeout: 60,
      resumeByLibrary: true,
      reconnectTries: 10,
      reconnectInterval: 5,
      restTimeout: 15,
      voiceConnectionTimeout: 30
    });

    this.manager.on("ready", (name, lavalinkResume, libraryResume) => {
      console.log(
        `[lavalink:${name}] ready lavalinkResume=${lavalinkResume} libraryResume=${libraryResume}`
      );
    });

    this.manager.on("error", (name, error) => {
      console.error(`[lavalink:${name}] error`, error);
    });

    this.manager.on("close", (name, code, reason) => {
      console.error(`[lavalink:${name}] closed code=${code} reason=${reason}`);
    });
  }

  async join(guildId: string, channelId: string, shardId: number) {
    this.assertEnabled();
    return this.manager.joinVoiceChannel({
      guildId,
      channelId,
      shardId,
      deaf: true
    });
  }

  async leave(guildId: string) {
    this.assertEnabled();
    await this.manager.leaveVoiceChannel(guildId);
  }

  async resolve(identifier: string): Promise<Track> {
    this.assertEnabled();
    const node = this.manager.getIdealNode();
    if (!node) {
      throw new Error("No Lavalink node is currently available.");
    }

    const response = await node.rest.resolve(identifier);
    if (!response) {
      throw new Error("Lavalink did not return a track response.");
    }

    switch (response.loadType) {
      case LoadType.TRACK:
        return response.data;
      case LoadType.SEARCH:
        if (!response.data.length) {
          throw new Error("Lavalink search returned no tracks.");
        }
        return response.data[0];
      case LoadType.PLAYLIST:
        if (!response.data.tracks.length) {
          throw new Error("Lavalink playlist returned no tracks.");
        }
        return response.data.tracks[
          response.data.info.selectedTrack >= 0 ? response.data.info.selectedTrack : 0
        ];
      default:
        throw new Error("Lavalink could not resolve a playable track for that input.");
    }
  }

  async resolvePlaylist(identifier: string): Promise<LavalinkPlaylist> {
    this.assertEnabled();
    const node = this.manager.getIdealNode();
    if (!node) {
      throw new Error("No Lavalink node is currently available.");
    }

    const response = await node.rest.resolve(identifier);
    if (!response) {
      throw new Error("Lavalink did not return a playlist response.");
    }

    if (response.loadType !== LoadType.PLAYLIST || !response.data.tracks.length) {
      throw new Error("That link did not resolve to a playable playlist.");
    }

    return {
      name: response.data.info.name || "Playlist",
      selectedTrack: response.data.info.selectedTrack,
      tracks: response.data.tracks
    };
  }

  async play(player: Player, encoded: string, volume: number, positionMs = 0) {
    this.assertEnabled();
    await player.playTrack({
      track: { encoded },
      volume,
      position: positionMs
    });
  }

  private assertEnabled(): asserts this is { manager: Shoukaku; enabled: true } & LavalinkService {
    if (!this.manager || !this.enabled) {
      throw new Error("Lavalink is not configured yet. Add your own node details before using voice commands.");
    }
  }
}
