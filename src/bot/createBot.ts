import {
  type Attachment,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
  type GuildMember,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type Message,
  type MessageCreateOptions,
  type MessageReplyOptions
} from "discord.js";
import { registerCommands, registeredCommandNames } from "./commands.js";
import { embedTextPayload } from "./messageEmbeds.js";
import { BOT_BRAND_NAME, BOT_ERROR_TITLE } from "../brand.js";
import { MusicManager } from "../music/musicManager.js";
import { LavalinkService } from "../music/lavalinkService.js";
import { LyricsService, type LyricsResult } from "../music/lyricsService.js";
import { StateStore } from "../storage/stateStore.js";
import { appConfig } from "../config.js";
import type { FilterPreset, MemberPermissionOverride, ResolvedTrack, SearchResult } from "../types.js";

function describeTrack(index: number, track: { title: string; artist?: string }) {
  return `${index}. ${track.title}${track.artist ? ` by ${track.artist}` : ""}`;
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

const playableUploadExtensions = new Set([
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

const knownCommandNames = new Set<string>(registeredCommandNames);
const commandDeleteDelayMs = appConfig.chatCommandDeleteAfterSeconds * 1000;

function formatQueue(snapshot: ReturnType<MusicManager["getSnapshot"]>) {
  const lines = [];

  if (snapshot.current) {
    lines.push(`Now: ${snapshot.current.title}${snapshot.current.artist ? ` by ${snapshot.current.artist}` : ""}`);
  }

  snapshot.upcoming.slice(0, 12).forEach((track, index) => {
    lines.push(describeTrack(index + 1, track));
  });

  if (!lines.length) {
    return "Queue is empty.";
  }

  return [
    `Autoplay: ${snapshot.autoplay ? "on" : "off"} | Vote skip: ${snapshot.voteSkipEnabled ? "on" : "off"} | Volume: ${snapshot.volume}% | Filter: ${snapshot.filterPreset}`,
    ...lines
  ].join("\n");
}

function formatSearchResults(query: string, results: SearchResult[]) {
  if (!results.length) {
    return `No results found for **${query}**.`;
  }

  return [
    `Top results for **${query}**:`,
    ...results.map((result, index) =>
      `${index + 1}. ${result.title}${result.artist ? ` by ${result.artist}` : ""} [${formatDuration(result.durationInSeconds)}]\n<${result.url}>`
    )
  ].join("\n");
}

function splitLongText(value: string, maxLength: number) {
  const chunks: string[] = [];
  let remaining = value.trim();

  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength);
    const breakpoint = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
    const splitAt = breakpoint > Math.floor(maxLength * 0.6) ? breakpoint : maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length) {
    chunks.push(remaining);
  }

  return chunks;
}

function formatLyricsChunks(result: LyricsResult) {
  const header = `Lyrics for **${result.title}**${result.artist ? ` by **${result.artist}**` : ""}`;
  const bodyChunks = splitLongText(result.lyrics, 1750);

  return bodyChunks.map((chunk, index) =>
    `${index === 0 ? header : `${header} (cont. ${index + 1})`}\n\n${chunk}`
  );
}

function isHttpUrl(value: string | undefined) {
  return Boolean(value && /^https?:\/\//i.test(value));
}

function createSavedTrackMessage(track: ResolvedTrack, guildName: string) {
  const sourceUrl = isHttpUrl(track.url) ? track.url : undefined;
  const playbackUrl = isHttpUrl(track.playbackUrl) ? track.playbackUrl : undefined;
  const lines = [
    `Saved from **${guildName}**`,
    `**${track.title}**${track.artist ? ` by ${track.artist}` : ""}`
  ];

  if (sourceUrl) {
    lines.push(`Source: <${sourceUrl}>`);
  }

  if (playbackUrl && playbackUrl !== sourceUrl) {
    lines.push(`Playable link: <${playbackUrl}>`);
  }

  return lines.join("\n");
}

function hasPlayableUploadExtension(value: string | null | undefined) {
  if (!value) {
    return false;
  }

  const normalized = value.split("?")[0]?.toLowerCase();
  const extension = normalized?.split(".").at(-1);
  return Boolean(extension && playableUploadExtensions.has(extension));
}

function normalizeCommandName(value: string) {
  const normalized = value.trim().toLowerCase().replace(/^\//, "");
  if (normalized === "np") {
    return "nowplaying";
  }

  if (normalized === "playlist") {
    return "shock-list";
  }

  return normalized;
}

function formatModerationSummary(music: MusicManager, guildId: string) {
  const settings = music.getGuildSettings(guildId);
  const disabledCommands = settings.disabledCommands.length ? settings.disabledCommands.join(", ") : "none";
  const channelOverrides = Object.entries(settings.channelSettings);
  const memberOverrides = Object.entries(settings.memberPermissions);
  const channelLines = channelOverrides.length
    ? channelOverrides.map(([channelId, override]) =>
      `<#${channelId}>: commands ${override.commandsEnabled === false ? "off" : "on"}, messages ${override.botMessagesEnabled === false ? "off" : "on"}`
    ).join("\n")
    : "none";
  const memberLines = memberOverrides.length
    ? memberOverrides.map(([memberId, override]) => `<@${memberId}>: ${override}`).join("\n")
    : "none";

  return [
    `Disabled commands: ${disabledCommands}`,
    `Max song length: ${settings.maxSongLengthSeconds ? `${settings.maxSongLengthSeconds}s` : "off"}`,
    `Max shock-list length: ${settings.maxPlaylistLength ? `${settings.maxPlaylistLength} tracks` : "off"}`,
    `Channel overrides:\n${channelLines}`,
    `Member overrides:\n${memberLines}`
  ].join("\n");
}

function isPlayableAttachment(attachment: Attachment) {
  const contentType = attachment.contentType?.toLowerCase();
  if (contentType?.startsWith("audio/") || contentType?.startsWith("video/")) {
    return true;
  }

  return hasPlayableUploadExtension(attachment.name) || hasPlayableUploadExtension(attachment.url);
}

function scheduleTimeout(task: () => void, delayMs: number) {
  const timer = setTimeout(task, delayMs);
  timer.unref?.();
}

function scheduleMessageDeletion(target: { delete: () => Promise<unknown> } | null | undefined) {
  if (!target || commandDeleteDelayMs <= 0) {
    return;
  }

  scheduleTimeout(() => {
    void target.delete().catch(() => undefined);
  }, commandDeleteDelayMs);
}

function scheduleInteractionReplyDeletion(interaction: ChatInputCommandInteraction) {
  if (commandDeleteDelayMs <= 0 || interaction.ephemeral || (!interaction.deferred && !interaction.replied)) {
    return;
  }

  scheduleTimeout(() => {
    void interaction.deleteReply().catch(() => undefined);
  }, commandDeleteDelayMs);
}

async function replyAndAutoDelete(message: Message, payload: string | MessageReplyOptions) {
  const reply = await message.reply(withMessageEmbedPayload(payload));
  scheduleMessageDeletion(reply);
  return reply;
}

function withMessageEmbedPayload(payload: string | MessageReplyOptions | MessageCreateOptions, title = BOT_BRAND_NAME) {
  if (typeof payload === "string") {
    return embedTextPayload(payload, { title });
  }

  if (payload.embeds?.length) {
    return payload;
  }

  if (typeof payload.content === "string") {
    const { content, ...rest } = payload;
    return {
      ...rest,
      ...embedTextPayload(content, { title })
    };
  }

  return payload;
}

function withInteractionReplyEmbedPayload(payload: string | InteractionReplyOptions, title = BOT_BRAND_NAME) {
  if (typeof payload === "string") {
    return embedTextPayload(payload, { title });
  }

  if (payload.embeds?.length) {
    return payload;
  }

  if (typeof payload.content === "string") {
    const { content, ...rest } = payload;
    return {
      ...rest,
      ...embedTextPayload(content, { title })
    };
  }

  return payload;
}

function withInteractionEditEmbedPayload(payload: string | InteractionEditReplyOptions, title = BOT_BRAND_NAME) {
  if (typeof payload === "string") {
    return embedTextPayload(payload, { title });
  }

  if (payload.embeds?.length) {
    return payload;
  }

  if (typeof payload.content === "string") {
    const { content, ...rest } = payload;
    return {
      ...rest,
      ...embedTextPayload(content, { title })
    };
  }

  return payload;
}

async function replyToInteraction(
  interaction: ChatInputCommandInteraction,
  payload: string | InteractionReplyOptions,
  title = BOT_BRAND_NAME
) {
  await interaction.reply(withInteractionReplyEmbedPayload(payload, title));
}

async function editInteractionReply(
  interaction: ChatInputCommandInteraction,
  payload: string | InteractionEditReplyOptions,
  title = BOT_BRAND_NAME
) {
  await interaction.editReply(withInteractionEditEmbedPayload(payload, title));
}

async function followUpInteraction(
  interaction: ChatInputCommandInteraction,
  payload: string | InteractionReplyOptions,
  title = BOT_BRAND_NAME,
  autoDelete = true
) {
  const followUp = await interaction.followUp(withInteractionReplyEmbedPayload(payload, title));
  if (autoDelete) {
    scheduleMessageDeletion("delete" in followUp ? followUp : undefined);
  }
  return followUp;
}

async function reportInteractionError(interaction: ChatInputCommandInteraction, message: string) {
  try {
    const payload = { ...embedTextPayload(message, { title: BOT_ERROR_TITLE, tone: "error" }), ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await followUpInteraction(interaction, payload);
    } else {
      await replyToInteraction(interaction, payload);
    }
  } catch (error) {
    console.error(`[slash:${interaction.commandName}] failed to send error response`, error);
  }
}

async function reportPrefixError(message: Message, command: string | undefined, replyText: string) {
  try {
    await replyAndAutoDelete(message, replyText);
  } catch (error) {
    console.error(`[prefix:${command ?? "unknown"}] failed to send error response`, error);
  }
}

async function requireGuildMember(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId || !interaction.guild) {
    throw new Error("This command must be used in a server.");
  }

  return interaction.guild.members.fetch(interaction.user.id);
}

async function ensureControlAccess(interaction: ChatInputCommandInteraction, music: MusicManager) {
  const member = await requireGuildMember(interaction);
  await music.assertCanControl(member, interaction.guildId!);
  return member;
}

/** Same moderator gate for slash and prefix — keeps `voteskip`, `prefix set`, `clean`, etc. aligned. */
async function ensureModeratorGuildMember(member: GuildMember, music: MusicManager) {
  await music.assertCanModerate(member);
  return member;
}

async function ensureModeratorAccess(interaction: ChatInputCommandInteraction, music: MusicManager) {
  return ensureModeratorGuildMember(await requireGuildMember(interaction), music);
}

async function ensureBotOwnerAccess(interaction: ChatInputCommandInteraction, music: MusicManager) {
  if (music.isBotOwnerId(interaction.user.id)) {
    return;
  }

  throw new Error("Only configured bot owners can use that command.");
}

function formatOwnerStatus(client: Client, music: MusicManager) {
  const activeGuildCount = music.listSnapshots().filter((snapshot) =>
    Boolean(snapshot.voiceChannelId || snapshot.current || snapshot.upcoming.length)
  ).length;

  return [
    `Configured owner IDs: ${appConfig.botOwners.length ? appConfig.botOwners.join(", ") : "none"}`,
    `Guilds connected: ${client.guilds.cache.size}`,
    `Guilds with active player state: ${activeGuildCount}`,
    `Command scope: ${appConfig.discordGuildId ? `guild-only (${appConfig.discordGuildId})` : "global"}`,
    `Lavalink: ${appConfig.lavalink ? `configured (${appConfig.lavalink.name} @ ${appConfig.lavalink.url})` : "not configured"}`,
    `Dashboard: ${appConfig.dashboardPublicUrl}`
  ].join("\n");
}

async function cleanBotMessages(message: Message | ChatInputCommandInteraction, amount = 50) {
  const channel = message.channel;
  if (!channel || !channel.isTextBased() || !("messages" in channel) || !("bulkDelete" in channel)) {
    throw new Error("Clean only works in guild text chats, including voice call chats.");
  }

  const botUserId = message.client.user?.id;
  if (!botUserId) {
    throw new Error("The bot user is not ready yet.");
  }

  const fetched = await channel.messages.fetch({ limit: Math.min(100, amount) });
  const botMessages = fetched.filter((entry) => entry.author.id === botUserId).first(100);

  if (!botMessages.length) {
    return 0;
  }

  await channel.bulkDelete(botMessages, true);
  return botMessages.length;
}

async function dmSavedTrack(
  user: Message["author"] | ChatInputCommandInteraction["user"],
  guildName: string,
  track: ResolvedTrack
) {
  await user.send({
    ...embedTextPayload(createSavedTrackMessage(track, guildName), { title: guildName })
  });
}

async function sendLyricsToInteraction(interaction: ChatInputCommandInteraction, result: LyricsResult) {
  const chunks = formatLyricsChunks(result);
  const [firstChunk, ...restChunks] = chunks;
  if (!firstChunk) {
    throw new Error("I found that song, but there were no lyrics to display.");
  }

  if (interaction.deferred || interaction.replied) {
    await editInteractionReply(interaction, firstChunk, "Lyrics");
  } else {
    await replyToInteraction(interaction, firstChunk, "Lyrics");
  }

  for (const chunk of restChunks) {
    await followUpInteraction(interaction, chunk, "Lyrics", false);
  }
}

async function sendLyricsToMessage(message: Message, result: LyricsResult) {
  const chunks = formatLyricsChunks(result);
  const [firstChunk, ...restChunks] = chunks;
  if (!firstChunk) {
    throw new Error("I found that song, but there were no lyrics to display.");
  }

  if (!("send" in message.channel)) {
    throw new Error("I couldn't post lyrics in this channel.");
  }

  await message.reply(withMessageEmbedPayload(firstChunk, "Lyrics"));
  for (const chunk of restChunks) {
    await message.channel.send(withMessageEmbedPayload(chunk, "Lyrics"));
  }
}

async function maybeSendKaraokeLyricsToMessage(
  message: Message,
  music: MusicManager,
  lyrics: LyricsService
) {
  const guildId = message.guild?.id;
  if (!guildId) {
    return;
  }

  const currentTrack = music.getCurrentTrack(guildId);
  if (!currentTrack) {
    return;
  }

  try {
    const target = lyrics.buildTarget({
      title: currentTrack.title,
      artist: currentTrack.artist,
      durationInSeconds: currentTrack.durationInSeconds
    });
    const lyricResult = await lyrics.lookup(target);
    await sendLyricsToMessage(message, lyricResult);
  } catch (error) {
    console.warn("[karaoke] failed to fetch lyrics for prefix command", error);
  }
}

async function maybeSendKaraokeLyricsToInteraction(
  interaction: ChatInputCommandInteraction,
  music: MusicManager,
  lyrics: LyricsService
) {
  const guildId = interaction.guildId;
  if (!guildId) {
    return;
  }

  const currentTrack = music.getCurrentTrack(guildId);
  if (!currentTrack) {
    return;
  }

  try {
    const target = lyrics.buildTarget({
      title: currentTrack.title,
      artist: currentTrack.artist,
      durationInSeconds: currentTrack.durationInSeconds
    });
    const lyricResult = await lyrics.lookup(target);
    const chunks = formatLyricsChunks(lyricResult);
    for (const chunk of chunks) {
      await followUpInteraction(interaction, chunk, "Lyrics", false);
    }
  } catch (error) {
    console.warn("[karaoke] failed to fetch lyrics for slash command", error);
  }
}

function resolveModerationChannelId(interaction: ChatInputCommandInteraction) {
  const explicitChannel = interaction.options.getChannel("channel", false);
  if (explicitChannel) {
    return explicitChannel.id;
  }

  if (!interaction.channelId) {
    throw new Error("Unable to determine which channel to update.");
  }

  return interaction.channelId;
}

function parseToggleValue(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if ([ "on", "true", "enable", "enabled", "yes" ].includes(normalized)) {
    return true;
  }

  if ([ "off", "false", "disable", "disabled", "no" ].includes(normalized)) {
    return false;
  }

  return undefined;
}

function readMentionId(raw: string | undefined, kind: "user" | "role" | "channel") {
  if (!raw) {
    return undefined;
  }

  const patterns = {
    user: /^<@!?(\d+)>$/,
    role: /^<@&(\d+)>$/,
    channel: /^<#(\d+)>$/
  } as const;

  const match = raw.match(patterns[kind]);
  return match?.[1];
}

function readSnowflake(raw: string | undefined) {
  return raw?.match(/\d{16,20}/)?.[0];
}

export async function createBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  const store = new StateStore();
  const lavalink = new LavalinkService(client);
  const music = new MusicManager(client, store, lavalink);
  const lyrics = new LyricsService();
  await music.init();

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await registerCommands();
    } catch (error) {
      console.error("[discord] failed to register slash commands", error);
    }

    console.log(`Discord bot ready as ${readyClient.user.tag}`);
  });

  client.on(Events.Error, (error) => {
    console.error("[discord] client error", error);
  });

  client.on(Events.Warn, (message) => {
    console.warn("[discord] warning", message);
  });

  client.on(Events.ShardError, (error, shardId) => {
    console.error(`[discord] shard ${shardId} error`, error);
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(`[discord] shard ${shardId} disconnected`, {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean
    });
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    console.warn(`[discord] shard ${shardId} reconnecting`);
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    console.log(`[discord] shard ${shardId} resumed with ${replayedEvents} replayed event${replayedEvents === 1 ? "" : "s"}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      await handleSlashCommand(interaction, music, lyrics);
      if (interaction.commandName !== "lyrics") {
        scheduleInteractionReplyDeletion(interaction);
      }
    } catch (error) {
      console.error(`[slash:${interaction.commandName}]`, error);
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await reportInteractionError(interaction, message);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!message.guild || message.author.bot) {
      return;
    }

    const prefix = music.getPrefix(message.guild.id);
    if (!message.content.startsWith(prefix)) {
      return;
    }

    const [rawCommand, ...rest] = message.content.slice(prefix.length).trim().split(/\s+/);
    const rawLower = rawCommand?.toLowerCase();
    const command = rawLower === "playlist" ? "shock-list" : rawLower;
    const query = rest.join(" ").trim();

    try {
      const normalizedCommand = command ? normalizeCommandName(command) : undefined;
      if (normalizedCommand && knownCommandNames.has(normalizedCommand)) {
        scheduleMessageDeletion(message);
        const member = await message.guild.members.fetch(message.author.id);
        await music.assertCanUseCommand(member, message.guild.id, normalizedCommand, message.channelId);
      }

      switch (command) {
        case "play": {
          const attachment = message.attachments.first();
          if (!query && attachment && !isPlayableAttachment(attachment)) {
            throw new Error("Attach a playable audio or video file like mp3, wav, m4a, flac, ogg, webm, or mp4.");
          }

          const input = query || attachment?.url;
          if (!input) throw new Error("Provide a song URL, search query, or attach a playable audio file.");
          const result = await music.playFromMessage(message, input);
          const [track] = result.tracks;
          if (!track) {
            throw new Error("No tracks were queued.");
          }

          await replyAndAutoDelete(
            message,
            result.tracks.length > 1
              ? `Queued **${result.tracks.length}**${result.playlistTotalTracks && result.playlistTotalTracks > result.tracks.length ? ` of **${result.playlistTotalTracks}**` : ""} tracks${result.playlistName ? ` from **${result.playlistName}**` : ""}.`
              : `Queued: **${track.title}**${track.artist ? ` by ${track.artist}` : ""}`
          );
          return;
        }
        case "insert": {
          const attachment = message.attachments.first();
          const insertQuery = rest.join(" ").trim();

          if (!insertQuery && attachment && !isPlayableAttachment(attachment)) {
            throw new Error("Attach a playable audio or video file like mp3, wav, m4a, flac, ogg, webm, or mp4.");
          }

          const input = insertQuery || attachment?.url;
          if (!input) {
            throw new Error("Provide a song URL, search query, or attached audio file to insert next.");
          }

          const track = await music.insertFromMessage(message, input);
          await replyAndAutoDelete(message, `Inserted **${track.title}** into the next queue spot.`);
          return;
        }
        case "skip":
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          if (rest[0]) {
            const skipTarget = Number.parseInt(rest[0], 10);
            if (!Number.isInteger(skipTarget)) {
              throw new Error("Use `skip` or `skip <queue position>`.");
            }
            await music.skipTo(message.guild.id, skipTarget);
            await replyAndAutoDelete(message, `Skipping to queue position ${skipTarget}.`);
            return;
          }

          await music.skip(message.guild.id);
          await replyAndAutoDelete(message, "Skipped.");
          return;
        case "move": {
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          const [fromRaw, toRaw] = rest;
          const from = Number.parseInt(fromRaw ?? "", 10);
          const to = Number.parseInt(toRaw ?? "", 10);
          if (!Number.isInteger(from) || !Number.isInteger(to)) {
            throw new Error("Use `move <from> <to>` with queue positions like `!move 5 2`.");
          }

          const moved = await music.move(message.guild.id, from, to);
          await replyAndAutoDelete(message, `Moved **${moved.title}** from #${from} to #${to}.`);
          return;
        }
        case "search": {
          if (!query) throw new Error("Provide search terms like `!search artists and songs`.");
          const results = await music.search(query);
          await replyAndAutoDelete(message, formatSearchResults(query, results));
          return;
        }
        case "lyrics": {
          const currentTrack = music.getCurrentTrack(message.guild.id);
          const target = lyrics.buildTarget({
            query: query || undefined,
            title: query ? undefined : currentTrack?.title,
            artist: query ? undefined : currentTrack?.artist,
            durationInSeconds: query ? undefined : currentTrack?.durationInSeconds
          });
          const lyricResult = await lyrics.lookup(target);
          await sendLyricsToMessage(message, lyricResult);
          return;
        }
        case "save": {
          const track = music.getCurrentTrack(message.guild.id);
          if (!track) {
            throw new Error("Nothing is playing right now.");
          }

          await dmSavedTrack(message.author, message.guild.name, track);
          await replyAndAutoDelete(message, "Sent the current song to your DMs.");
          return;
        }
        case "filter": {
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          const preset = rest[0]?.toLowerCase() as FilterPreset | undefined;
          if (!preset || !["off", "bassboost", "nightcore", "vaporwave", "karaoke", "trebleboost", "8d"].includes(preset)) {
            throw new Error("Use `filter <off|bassboost|nightcore|vaporwave|karaoke|trebleboost|8d>`.");
          }

          await music.setFilterPreset(message.guild.id, preset);
          await replyAndAutoDelete(message, `Filter set to **${preset}**.`);
          if (preset === "karaoke") {
            await maybeSendKaraokeLyricsToMessage(message, music, lyrics);
          }
          return;
        }
        case "queue":
          await replyAndAutoDelete(message, formatQueue(music.getSnapshot(message.guild.id)));
          return;
        case "nowplaying":
        case "np": {
          const current = music.getSnapshot(message.guild.id).current;
          await replyAndAutoDelete(message, current ? `Now playing: **${current.title}**` : "Nothing is playing.");
          return;
        }
        case "pause":
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          await music.pause(message.guild.id);
          await replyAndAutoDelete(message, "Paused.");
          return;
        case "resume":
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          await music.resume(message.guild.id);
          await replyAndAutoDelete(message, "Resumed.");
          return;
        case "join": {
          const voiceChannel = await music.joinFromMessage(message);
          await replyAndAutoDelete(message, `Joined **${voiceChannel.name}**.`);
          return;
        }
        case "stop":
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          await music.stop(message.guild.id);
          await replyAndAutoDelete(message, "Stopped playback and disconnected.");
          return;
        case "clear":
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          await music.clearQueue(message.guild.id);
          await replyAndAutoDelete(message, "Queue cleared.");
          return;
        case "volume": {
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          const percent = Number.parseInt(rest[0] ?? "", 10);
          if (!Number.isInteger(percent)) {
            throw new Error("Use `volume <1-150>`.");
          }

          await music.setVolume(message.guild.id, percent);
          await replyAndAutoDelete(message, `Volume set to ${percent}%.`);
          return;
        }
        case "remove": {
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          const index = Number.parseInt(rest[0] ?? "", 10);
          if (!Number.isInteger(index)) {
            throw new Error("Use `remove <position>`.");
          }

          const removed = await music.remove(message.guild.id, index);
          await replyAndAutoDelete(message, `Removed **${removed.title}**.`);
          return;
        }
        case "removelast": {
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          const removedLast = await music.removeLast(message.guild.id);
          await replyAndAutoDelete(message, removedLast ? `Removed **${removedLast.title}**.` : "The queue is already empty.");
          return;
        }
        case "removeduplicates": {
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          const duplicateCount = await music.removeDuplicates(message.guild.id);
          await replyAndAutoDelete(message, `Removed ${duplicateCount} duplicate ${duplicateCount === 1 ? "track" : "tracks"}.`);
          return;
        }
        case "removeabsent": {
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          const absentCount = await music.removeAbsent(message.guild.id);
          await replyAndAutoDelete(message, `Removed ${absentCount} queue entries from absent users.`);
          return;
        }
        case "massremove": {
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          const start = Number.parseInt(rest[0] ?? "", 10);
          const count = Number.parseInt(rest[1] ?? "", 10);
          if (!Number.isInteger(start) || !Number.isInteger(count)) {
            throw new Error("Use `massremove <start> <count>`.");
          }

          const removedCount = await music.massRemove(message.guild.id, start, count);
          await replyAndAutoDelete(message, `Removed ${removedCount} track${removedCount === 1 ? "" : "s"} from the queue.`);
          return;
        }
        case "previous":
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          await music.playPrevious(message.guild.id);
          await replyAndAutoDelete(message, "Playing the previous track.");
          return;
        case "fastforward": {
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          const seconds = Number.parseInt(rest[0] ?? "", 10);
          if (!Number.isInteger(seconds)) {
            throw new Error("Use `fastforward <seconds>`.");
          }
          await music.seekRelative(message.guild.id, seconds);
          await replyAndAutoDelete(message, "Jumped forward.");
          return;
        }
        case "rewind": {
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          const seconds = Number.parseInt(rest[0] ?? "", 10);
          if (!Number.isInteger(seconds)) {
            throw new Error("Use `rewind <seconds>`.");
          }
          await music.seekRelative(message.guild.id, -seconds);
          await replyAndAutoDelete(message, "Jumped backward.");
          return;
        }
        case "autoplay": {
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          const enabled = parseToggleValue(rest[0]);
          if (enabled === undefined) {
            throw new Error("Use `autoplay <on|off>`.");
          }
          const autoplay = await music.updateGuildSettings(message.guild.id, { autoplay: enabled });
          await replyAndAutoDelete(message, `Autoplay is now ${autoplay.autoplay ? "on" : "off"}.`);
          return;
        }
        case "voteskip": {
          await ensureModeratorGuildMember(await message.guild.members.fetch(message.author.id), music);
          const enabled = parseToggleValue(rest[0]);
          const voteSkipEnabled = await music.toggleVoteSkip(message.guild.id, enabled);
          await replyAndAutoDelete(message, `Vote skip is now ${voteSkipEnabled ? "on" : "off"}.`);
          return;
        }
        case "prefix": {
          const subcommand = rest[0]?.toLowerCase() ?? "show";
          if (subcommand === "show") {
            await replyAndAutoDelete(message, `Current prefix: \`${music.getPrefix(message.guild.id)}\``);
            return;
          }

          await ensureModeratorGuildMember(await message.guild.members.fetch(message.author.id), music);
          const newPrefix = rest.slice(1).join(" ").trim();
          if (!newPrefix) {
            throw new Error("Use `prefix set <value>`.");
          }
          await music.updateGuildSettings(message.guild.id, { prefix: newPrefix });
          await replyAndAutoDelete(message, `Prefix updated to \`${newPrefix}\`.`);
          return;
        }
        case "permissions":
          await handlePrefixPermissionsCommand(message, music, rest);
          return;
        case "shock-list":
          await handlePrefixPlaylistCommand(message, music, rest);
          return;
        case "moderation":
          await handlePrefixModerationCommand(message, music, rest);
          return;
        case "owner": {
          if (!music.isBotOwnerId(message.author.id)) {
            throw new Error("Only configured bot owners can use that command.");
          }

          const subcommand = rest[0]?.toLowerCase() ?? "status";
          if (subcommand === "status") {
            await replyAndAutoDelete(message, formatOwnerStatus(client, music));
            return;
          }

          if (subcommand === "synccommands") {
            await registerCommands();
            await replyAndAutoDelete(
              message,
              `Slash commands re-registered using ${appConfig.discordGuildId ? "guild" : "global"} scope.`
            );
            return;
          }

          throw new Error("Use `owner status` or `owner synccommands`.");
        }
        case "clean": {
          await ensureModeratorGuildMember(await message.guild.members.fetch(message.author.id), music);

          const cleaned = await cleanBotMessages(message, Number.parseInt(rest[0] ?? "", 10) || 50);
          await replyAndAutoDelete(message, `Deleted ${cleaned} bot message${cleaned === 1 ? "" : "s"}.`);
          return;
        }
      }
    } catch (error) {
      console.error(`[prefix:${command ?? "unknown"}]`, error);
      await reportPrefixError(message, command, error instanceof Error ? error.message : "Something went wrong.");
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
  return { client, music };
}

async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  music: MusicManager,
  lyrics: LyricsService
) {
  const guildId = interaction.guildId;
  if (guildId && interaction.guild) {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    await music.assertCanUseCommand(member, guildId, interaction.commandName, interaction.channelId);
  }

  switch (interaction.commandName) {
    case "join": {
      await interaction.deferReply({ ephemeral: true });
      const voiceChannel = await music.join(interaction);
      await editInteractionReply(interaction, `Joined **${voiceChannel.name}**.`, "Voice Connected");
      return;
    }

    case "play": {
      await interaction.deferReply({ ephemeral: true });
      const playMode = interaction.options.getSubcommand();
      const query = playMode === "query" ? interaction.options.getString("value", true).trim() : undefined;
      const file = playMode === "file" ? interaction.options.getAttachment("value", true) : undefined;

      if (file && !isPlayableAttachment(file)) {
        throw new Error("Upload a playable audio or video file like mp3, wav, m4a, flac, ogg, webm, or mp4.");
      }

      const input = file?.url ?? query;
      if (!input) {
        throw new Error("Provide a song URL, search query, or uploaded audio file.");
      }

      const result = await music.play(interaction, input);
      const [track] = result.tracks;
      if (!track) {
        throw new Error("No tracks were queued.");
      }

      await editInteractionReply(
        interaction,
        result.tracks.length > 1
          ? `Queued **${result.tracks.length}**${result.playlistTotalTracks && result.playlistTotalTracks > result.tracks.length ? ` of **${result.playlistTotalTracks}**` : ""} tracks${result.playlistName ? ` from **${result.playlistName}**` : ""}.`
          : `Queued: **${track.title}**${track.artist ? ` by ${track.artist}` : ""}`,
        result.tracks.length > 1 ? "Queued Playlist" : "Queued Track"
      );
      return;
    }

    case "insert": {
      await interaction.deferReply({ ephemeral: true });
      const query = interaction.options.getString("query", false)?.trim();
      const file = interaction.options.getAttachment("file", false);

      if (query && file) {
        throw new Error("Use either a search query/URL or an uploaded file, not both at the same time.");
      }

      if (file && !isPlayableAttachment(file)) {
        throw new Error("Upload a playable audio or video file like mp3, wav, m4a, flac, ogg, webm, or mp4.");
      }

      const input = file?.url ?? query;
      if (!input) {
        throw new Error("Provide a song URL, search query, or uploaded audio file to insert next.");
      }

      const track = await music.insert(interaction, input);
      await editInteractionReply(
        interaction,
        `Inserted: **${track.title}**${track.artist ? ` by ${track.artist}` : ""} into the next queue spot.`,
        "Inserted Track"
      );
      return;
    }

    case "search": {
      await interaction.deferReply();
      const query = interaction.options.getString("query", true);
      const results = await music.search(query);
      await editInteractionReply(interaction, formatSearchResults(query, results), "Search Results");
      return;
    }

    case "lyrics": {
      const query = interaction.options.getString("query", false)?.trim();
      const currentTrack = guildId ? music.getCurrentTrack(guildId) : undefined;
      const target = lyrics.buildTarget({
        query: query || undefined,
        title: query ? undefined : currentTrack?.title,
        artist: query ? undefined : currentTrack?.artist,
        durationInSeconds: query ? undefined : currentTrack?.durationInSeconds
      });
      await interaction.deferReply();
      const lyricResult = await lyrics.lookup(target);
      await sendLyricsToInteraction(interaction, lyricResult);
      return;
    }

    case "save":
      if (!guildId || !interaction.guild) throw new Error("This command must be used in a server.");
      const trackToSave = music.getCurrentTrack(guildId);
      if (!trackToSave) {
        throw new Error("Nothing is playing right now.");
      }

      await dmSavedTrack(interaction.user, interaction.guild.name, trackToSave);
      await replyToInteraction(interaction, { ...embedTextPayload("Sent the current song to your DMs.", { title: "Saved Track" }), ephemeral: true });
      return;

    case "pause":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      await music.pause(guildId);
      await replyToInteraction(interaction, "Playback paused.", "Playback Updated");
      return;

    case "resume":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      await music.resume(guildId);
      await replyToInteraction(interaction, "Playback resumed.", "Playback Updated");
      return;

    case "stop":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      await music.stop(guildId);
      await replyToInteraction(interaction, "Stopped playback and disconnected.", "Playback Updated");
      return;

    case "clear":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      await music.clearQueue(guildId);
      await replyToInteraction(interaction, "Queue cleared.", "Queue Updated");
      return;

    case "queue":
      if (!guildId) throw new Error("This command must be used in a server.");
      await replyToInteraction(interaction, { ...embedTextPayload(formatQueue(music.getSnapshot(guildId)), { title: "Current Queue" }), ephemeral: true });
      return;

    case "nowplaying":
      if (!guildId) throw new Error("This command must be used in a server.");
      const snapshot = music.getSnapshot(guildId);
      await replyToInteraction(
        interaction,
        snapshot.current
          ? `Now playing: **${snapshot.current.title}**${snapshot.current.artist ? ` by ${snapshot.current.artist}` : ""}`
          : "Nothing is playing right now.",
        "Now Playing"
      );
      return;

    case "volume":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      await music.setVolume(guildId, interaction.options.getInteger("percent", true));
      await replyToInteraction(interaction, `Volume set to ${interaction.options.getInteger("percent", true)}%.`, "Playback Updated");
      return;

    case "filter":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      const preset = interaction.options.getString("preset", true) as FilterPreset;
      await music.setFilterPreset(guildId, preset);
      await replyToInteraction(interaction, `Filter set to **${preset}**.`, "Playback Updated");
      if (preset === "karaoke") {
        await maybeSendKaraokeLyricsToInteraction(interaction, music, lyrics);
      }
      return;

    case "skip":
      if (!guildId) throw new Error("This command must be used in a server.");
      const skipTo = interaction.options.getInteger("to", false);
      if (skipTo) {
        await ensureControlAccess(interaction, music);
        await music.skipTo(guildId, skipTo);
        await replyToInteraction(interaction, `Skipping to queue position ${skipTo}.`, "Queue Updated");
        return;
      }

      const voteResult = await music.handleVoteSkip(interaction);
      await replyToInteraction(
        interaction,
        voteResult.skipped
          ? "Track skipped."
          : `Vote recorded: ${voteResult.votes}/${voteResult.needed} votes.`,
        "Vote Skip"
      );
      return;

    case "remove":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      const removed = await music.remove(guildId, interaction.options.getInteger("index", true));
      await replyToInteraction(interaction, `Removed **${removed.title}**.`, "Queue Updated");
      return;

    case "move":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      const from = interaction.options.getInteger("from", true);
      const to = interaction.options.getInteger("to", true);
      const moved = await music.move(guildId, from, to);
      await replyToInteraction(interaction, `Moved **${moved.title}** from #${from} to #${to}.`, "Queue Updated");
      return;

    case "removelast":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      const removedLast = await music.removeLast(guildId);
      await replyToInteraction(interaction, removedLast ? `Removed **${removedLast.title}**.` : "The queue is already empty.", "Queue Updated");
      return;

    case "removeduplicates":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      const duplicateCount = await music.removeDuplicates(guildId);
      await replyToInteraction(interaction, `Removed ${duplicateCount} duplicate ${duplicateCount === 1 ? "track" : "tracks"}.`, "Queue Updated");
      return;

    case "removeabsent":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      const absentCount = await music.removeAbsent(guildId);
      await replyToInteraction(interaction, `Removed ${absentCount} queue entries from absent users.`, "Queue Updated");
      return;

    case "massremove":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      const removedCount = await music.massRemove(
        guildId,
        interaction.options.getInteger("start", true),
        interaction.options.getInteger("count", true)
      );
      await replyToInteraction(interaction, `Removed ${removedCount} track${removedCount === 1 ? "" : "s"} from the queue.`, "Queue Updated");
      return;

    case "previous":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      await music.playPrevious(guildId);
      await replyToInteraction(interaction, "Playing the previous track.", "Playback Updated");
      return;

    case "fastforward":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      await music.seekRelative(guildId, interaction.options.getInteger("seconds", true));
      await replyToInteraction(interaction, "Jumped forward.", "Playback Updated");
      return;

    case "rewind":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      await music.seekRelative(guildId, -interaction.options.getInteger("seconds", true));
      await replyToInteraction(interaction, "Jumped backward.", "Playback Updated");
      return;

    case "autoplay":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      const autoplay = await music.updateGuildSettings(guildId, {
        autoplay: interaction.options.getBoolean("enabled", true)
      });
      await replyToInteraction(interaction, `Autoplay is now ${autoplay.autoplay ? "on" : "off"}.`, "Autoplay");
      return;

    case "voteskip":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureModeratorAccess(interaction, music);
      const voteSkipEnabled = await music.toggleVoteSkip(
        guildId,
        interaction.options.getBoolean("enabled", false) ?? undefined
      );
      await replyToInteraction(interaction, `Vote skip is now ${voteSkipEnabled ? "on" : "off"}.`, "Vote Skip");
      return;

    case "prefix":
      if (!guildId) throw new Error("This command must be used in a server.");
      const prefixSubcommand = interaction.options.getSubcommand();
      if (prefixSubcommand === "show") {
        await replyToInteraction(interaction, `Current prefix: \`${music.getPrefix(guildId)}\``, "Prefix");
        return;
      }
      await ensureModeratorAccess(interaction, music);
      const newPrefix = interaction.options.getString("value", true);
      await music.updateGuildSettings(guildId, { prefix: newPrefix });
      await replyToInteraction(interaction, `Prefix updated to \`${newPrefix}\`.`, "Prefix");
      return;

    case "permissions":
      if (!guildId) throw new Error("This command must be used in a server.");
      await handlePermissionsCommand(interaction, music);
      return;

    case "moderation":
      if (!guildId) throw new Error("This command must be used in a server.");
      await handleModerationCommand(interaction, music);
      return;

    case "owner": {
      await ensureBotOwnerAccess(interaction, music);
      await interaction.deferReply({ ephemeral: true });

      const subcommand = interaction.options.getSubcommand();
      if (subcommand === "status") {
        await editInteractionReply(interaction, formatOwnerStatus(interaction.client, music), "Owner Status");
        return;
      }

      await registerCommands();
      await editInteractionReply(
        interaction,
        `Slash commands re-registered using ${appConfig.discordGuildId ? "guild" : "global"} scope.`,
        "Owner Command"
      );
      return;
    }

    case "shock-list":
      if (!guildId) throw new Error("This command must be used in a server.");
      await handlePlaylistCommand(interaction, music);
      return;

    case "clean": {
      await ensureModeratorAccess(interaction, music);

      await interaction.deferReply({ ephemeral: true });
      const cleaned = await cleanBotMessages(interaction, interaction.options.getInteger("amount", false) ?? 50);
      await editInteractionReply(interaction, `Deleted ${cleaned} bot message${cleaned === 1 ? "" : "s"}.`, "Cleaned Messages");
      return;
    }
  }
}

async function handlePermissionsCommand(interaction: ChatInputCommandInteraction, music: MusicManager) {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    throw new Error("This command must be used in a server.");
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  await music.assertCanModerate(member);

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "show") {
    const settings = music.getGuildSettings(guildId);
    await replyToInteraction(
      interaction,
      `Mode: **${settings.permissionMode}**\nDJ role: ${settings.djRoleId ? `<@&${settings.djRoleId}>` : "not set"}`,
      "Permissions"
    );
    return;
  }

  if (subcommand === "mode") {
    const value = interaction.options.getString("value", true) as "everyone" | "dj" | "admins";
    await music.updateGuildSettings(guildId, { permissionMode: value });
    await replyToInteraction(interaction, `Permission mode set to **${value}**.`, "Permissions");
    return;
  }

  const role = interaction.options.getRole("role", false);
  await music.updateGuildSettings(guildId, { djRoleId: role?.id });
  await replyToInteraction(interaction, role ? `DJ role set to ${role}.` : "DJ role cleared.", "Permissions");
}

async function handlePrefixPermissionsCommand(message: Message, music: MusicManager, args: string[]) {
  const guildId = message.guild?.id;
  if (!guildId || !message.guild) {
    throw new Error("This command must be used in a server.");
  }

  const member = await message.guild.members.fetch(message.author.id);
  await music.assertCanModerate(member);

  const subcommand = args[0]?.toLowerCase() ?? "show";
  if (subcommand === "show") {
    const settings = music.getGuildSettings(guildId);
    await replyAndAutoDelete(
      message,
      `Mode: **${settings.permissionMode}**\nDJ role: ${settings.djRoleId ? `<@&${settings.djRoleId}>` : "not set"}`
    );
    return;
  }

  if (subcommand === "mode") {
    const value = args[1]?.toLowerCase();
    if (value !== "everyone" && value !== "dj" && value !== "admins") {
      throw new Error("Use `permissions mode <everyone|dj|admins>`.");
    }

    await music.updateGuildSettings(guildId, { permissionMode: value });
    await replyAndAutoDelete(message, `Permission mode set to **${value}**.`);
    return;
  }

  if (subcommand !== "djrole") {
    throw new Error("Use `permissions show`, `permissions mode ...`, or `permissions djrole ...`.");
  }

  const roleId = message.mentions.roles.first()?.id ?? readMentionId(args[1], "role") ?? readSnowflake(args[1]);
  const clearRole = !args[1] || ["clear", "none", "off"].includes(args[1].toLowerCase());
  await music.updateGuildSettings(guildId, { djRoleId: clearRole ? undefined : roleId });
  await replyAndAutoDelete(
    message,
    clearRole
      ? "DJ role cleared."
      : roleId
        ? `DJ role set to <@&${roleId}>.`
        : "Use `permissions djrole <@role>` or `permissions djrole clear`."
  );
}

async function handlePrefixModerationCommand(message: Message, music: MusicManager, args: string[]) {
  const guildId = message.guild?.id;
  if (!guildId || !message.guild) {
    throw new Error("This command must be used in a server.");
  }

  const member = await message.guild.members.fetch(message.author.id);
  await music.assertCanModerate(member);

  const subcommand = args[0]?.toLowerCase() ?? "show";
  switch (subcommand) {
    case "show":
      await replyAndAutoDelete(message, formatModerationSummary(music, guildId));
      return;

    case "channelmessages":
    case "channelcommands": {
      const enabled = parseToggleValue(args[1]);
      if (enabled === undefined) {
        throw new Error(`Use \`moderation ${subcommand} <on|off> [#channel]\`.`);
      }

      const channelId = message.mentions.channels.first()?.id ?? readMentionId(args[2], "channel") ?? readSnowflake(args[2]) ?? message.channelId;
      if (subcommand === "channelmessages") {
        await music.setChannelBotMessagesEnabled(guildId, channelId, enabled);
        await replyAndAutoDelete(message, `Bot messages are now ${enabled ? "enabled" : "disabled"} in <#${channelId}>.`);
        return;
      }

      await music.setChannelCommandsEnabled(guildId, channelId, enabled);
      await replyAndAutoDelete(message, `Bot commands are now ${enabled ? "enabled" : "disabled"} in <#${channelId}>.`);
      return;
    }

    case "command": {
      const commandName = normalizeCommandName(args[1] ?? "");
      const enabled = parseToggleValue(args[2]);
      if (!commandName || !knownCommandNames.has(commandName) || enabled === undefined) {
        throw new Error("Use `moderation command <name> <on|off>`.");
      }

      await music.setCommandEnabled(guildId, commandName, enabled);
      await replyAndAutoDelete(message, `The \`${commandName}\` command is now ${enabled ? "enabled" : "disabled"} in this server.`);
      return;
    }

    case "member": {
      const targetId = message.mentions.users.first()?.id ?? readMentionId(args[1], "user") ?? readSnowflake(args[1]);
      const access = args[2]?.toLowerCase() as MemberPermissionOverride | "clear" | undefined;
      if (!targetId || !access || !["allow", "deny", "clear"].includes(access)) {
        throw new Error("Use `moderation member <@user> <allow|deny|clear>`.");
      }

      await music.setMemberPermissionOverride(guildId, targetId, access === "clear" ? undefined : access);
      await replyAndAutoDelete(
        message,
        access === "clear"
          ? `Cleared the bot permission override for <@${targetId}>.`
          : `Set <@${targetId}> to **${access}** for bot access overrides.`
      );
      return;
    }

    case "removeuser": {
      const targetId = message.mentions.users.first()?.id ?? readMentionId(args[1], "user") ?? readSnowflake(args[1]);
      if (!targetId) {
        throw new Error("Use `moderation removeuser <@user>`.");
      }

      const removedCount = await music.removeByUser(guildId, targetId);
      await replyAndAutoDelete(message, `Removed ${removedCount} track${removedCount === 1 ? "" : "s"} added by <@${targetId}>.`);
      return;
    }

    case "maxsonglength": {
      const seconds = Number.parseInt(args[1] ?? "", 10);
      if (!Number.isInteger(seconds) || seconds < 0) {
        throw new Error("Use `moderation maxsonglength <seconds>`.");
      }

      await music.updateGuildSettings(guildId, {
        maxSongLengthSeconds: seconds > 0 ? seconds : undefined
      });
      await replyAndAutoDelete(
        message,
        seconds > 0 ? `Maximum song length set to ${seconds} seconds.` : "Maximum song length limit cleared."
      );
      return;
    }

    case "maxplaylistlength":
    case "maxshocklistlength": {
      const tracks = Number.parseInt(args[1] ?? "", 10);
      if (!Number.isInteger(tracks) || tracks < 0) {
        throw new Error("Use `moderation maxshocklistlength <tracks>`.");
      }

      await music.updateGuildSettings(guildId, {
        maxPlaylistLength: tracks > 0 ? tracks : undefined
      });
      await replyAndAutoDelete(
        message,
        tracks > 0 ? `Maximum shock-list length set to ${tracks} tracks.` : "Maximum shock-list length limit cleared."
      );
      return;
    }
  }

  throw new Error("Unknown moderation subcommand.");
}

async function handlePrefixPlaylistCommand(message: Message, music: MusicManager, args: string[]) {
  const guildId = message.guild?.id;
  if (!guildId || !message.guild) {
    throw new Error("This command must be used in a server.");
  }

  const member = await message.guild.members.fetch(message.author.id);
  const subcommand = args[0]?.toLowerCase() ?? "list";
  const name = args.slice(1).join(" ").trim();

  switch (subcommand) {
    case "save": {
      if (!name) {
        throw new Error("Use `shock-list save <name>`.");
      }
      await music.assertCanControl(member, guildId);
      const playlist = await music.createOrReplacePlaylist(guildId, name, message.author.id);
      await replyAndAutoDelete(message, `Saved shock-list **${playlist.name}** with ${playlist.tracks.length} tracks.`);
      return;
    }
    case "load": {
      if (!name) {
        throw new Error("Use `shock-list load <name>`.");
      }
      await music.assertCanControl(member, guildId);
      const count = await music.loadPlaylistFromMessage(message, name);
      await replyAndAutoDelete(message, `Loaded ${count} track${count === 1 ? "" : "s"} into the queue.`);
      return;
    }
    case "addcurrent": {
      if (!name) {
        throw new Error("Use `shock-list addcurrent <name>`.");
      }
      await music.assertCanControl(member, guildId);
      const playlist = await music.addCurrentToPlaylist(guildId, name, message.author.id);
      await replyAndAutoDelete(message, `Shock-list **${playlist.name}** now has ${playlist.tracks.length} tracks.`);
      return;
    }
    case "list": {
      const playlists = music.listPlaylists(guildId);
      await replyAndAutoDelete(
        message,
        playlists.length
          ? playlists.map((playlist) => `• ${playlist.name} (${playlist.tracks.length})`).join("\n")
          : "No saved shock-lists yet."
      );
      return;
    }
    case "delete": {
      if (!name) {
        throw new Error("Use `shock-list delete <name>`.");
      }
      await music.assertCanControl(member, guildId);
      await music.deletePlaylist(guildId, name);
      await replyAndAutoDelete(message, "Shock-list deleted.");
      return;
    }
  }

  throw new Error("Unknown shock-list subcommand.");
}

async function handleModerationCommand(interaction: ChatInputCommandInteraction, music: MusicManager) {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    throw new Error("This command must be used in a server.");
  }

  await ensureModeratorAccess(interaction, music);
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "show":
      await replyToInteraction(interaction, { ...embedTextPayload(formatModerationSummary(music, guildId), { title: "Moderation Settings" }), ephemeral: true });
      return;

    case "channelmessages": {
      const enabled = interaction.options.getBoolean("enabled", true);
      const channelId = resolveModerationChannelId(interaction);
      await music.setChannelBotMessagesEnabled(guildId, channelId, enabled);
      await replyToInteraction(interaction, `Bot messages are now ${enabled ? "enabled" : "disabled"} in <#${channelId}>.`, "Moderation Updated");
      return;
    }

    case "channelcommands": {
      const enabled = interaction.options.getBoolean("enabled", true);
      const channelId = resolveModerationChannelId(interaction);
      await music.setChannelCommandsEnabled(guildId, channelId, enabled);
      await replyToInteraction(interaction, `Bot commands are now ${enabled ? "enabled" : "disabled"} in <#${channelId}>.`, "Moderation Updated");
      return;
    }

    case "command": {
      const rawName = interaction.options.getString("name", true);
      const commandName = normalizeCommandName(rawName);
      if (!knownCommandNames.has(commandName)) {
        throw new Error(`Unknown command \`${rawName}\`. Try one of: ${[...knownCommandNames].sort().join(", ")}.`);
      }

      const enabled = interaction.options.getBoolean("enabled", true);
      await music.setCommandEnabled(guildId, commandName, enabled);
      await replyToInteraction(interaction, `The \`${commandName}\` command is now ${enabled ? "enabled" : "disabled"} in this server.`, "Moderation Updated");
      return;
    }

    case "member": {
      const target = interaction.options.getUser("member", true);
      const access = interaction.options.getString("access", true) as MemberPermissionOverride | "clear";
      await music.setMemberPermissionOverride(guildId, target.id, access === "clear" ? undefined : access);
      await replyToInteraction(
        interaction,
        access === "clear"
          ? `Cleared the bot permission override for **${target.username}**.`
          : `Set **${target.username}** to **${access}** for bot access overrides.`,
        "Moderation Updated"
      );
      return;
    }

    case "removeuser": {
      const target = interaction.options.getUser("member", true);
      const removedCount = await music.removeByUser(guildId, target.id);
      await replyToInteraction(interaction, `Removed ${removedCount} track${removedCount === 1 ? "" : "s"} added by **${target.username}**.`, "Moderation Updated");
      return;
    }

    case "maxsonglength": {
      const seconds = interaction.options.getInteger("seconds", true);
      await music.updateGuildSettings(guildId, {
        maxSongLengthSeconds: seconds > 0 ? seconds : undefined
      });
      await replyToInteraction(
        interaction,
        seconds > 0
          ? `Maximum song length set to ${seconds} seconds.`
          : "Maximum song length limit cleared.",
        "Moderation Updated"
      );
      return;
    }

    case "maxshocklistlength": {
      const tracks = interaction.options.getInteger("tracks", true);
      await music.updateGuildSettings(guildId, {
        maxPlaylistLength: tracks > 0 ? tracks : undefined
      });
      await replyToInteraction(
        interaction,
        tracks > 0
          ? `Maximum shock-list length set to ${tracks} tracks.`
          : "Maximum shock-list length limit cleared.",
        "Moderation Updated"
      );
      return;
    }
  }
}

async function handlePlaylistCommand(interaction: ChatInputCommandInteraction, music: MusicManager) {
  const guildId = interaction.guildId;
  if (!guildId) {
    throw new Error("This command must be used in a server.");
  }

  const subcommand = interaction.options.getSubcommand();
  switch (subcommand) {
    case "save": {
      await ensureControlAccess(interaction, music);
      const playlist = await music.createOrReplacePlaylist(
        guildId,
        interaction.options.getString("name", true),
        interaction.user.id
      );
      await replyToInteraction(interaction, `Saved shock-list **${playlist.name}** with ${playlist.tracks.length} tracks.`, "Shock-list Updated");
      return;
    }
    case "load": {
      await ensureControlAccess(interaction, music);
      const count = await music.loadPlaylist(interaction, interaction.options.getString("name", true));
      await replyToInteraction(interaction, `Loaded ${count} track${count === 1 ? "" : "s"} into the queue.`, "Shock-list Updated");
      return;
    }
    case "addcurrent": {
      await ensureControlAccess(interaction, music);
      const playlist = await music.addCurrentToPlaylist(
        guildId,
        interaction.options.getString("name", true),
        interaction.user.id
      );
      await replyToInteraction(interaction, `Shock-list **${playlist.name}** now has ${playlist.tracks.length} tracks.`, "Shock-list Updated");
      return;
    }
    case "list": {
      const playlists = music.listPlaylists(guildId);
      await replyToInteraction(
        interaction,
        playlists.length
          ? playlists.map((playlist) => `• ${playlist.name} (${playlist.tracks.length})`).join("\n")
          : "No saved shock-lists yet.",
        "Saved Shock-lists"
      );
      return;
    }
    case "delete":
      await ensureControlAccess(interaction, music);
      await music.deletePlaylist(guildId, interaction.options.getString("name", true));
      await replyToInteraction(interaction, "Shock-list deleted.", "Shock-list Updated");
      return;
  }
}
