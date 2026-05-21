import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ActionRowBuilder,
  type AutocompleteInteraction,
  type Attachment,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Client, 
  EmbedBuilder,
  Events, 
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
  type GuildMember,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type Message,
  type MessageCreateOptions,
  type MessageReplyOptions,
  MessageType,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction
} from "discord.js";
import { registerCommands, registeredCommandNames } from "./commands.js";
import { embedTextPayload } from "./messageEmbeds.js";
import { BOT_BRAND_NAME, BOT_ERROR_TITLE } from "../brand.js";
import { MusicManager } from "../music/musicManager.js";
import { LavalinkService } from "../music/lavalinkService.js";
import { LyricsService, type LyricsResult } from "../music/lyricsService.js";
import { StateStore } from "../storage/stateStore.js";
import { appConfig } from "../config.js";
import type { FilterPreset, MemberPermissionOverride, PlaybackHistoryEntry, Playlist, QueueSnapshot, ResolvedTrack, SearchResult } from "../types.js";  

function truncateQueueText(value: string | undefined, maxLength: number) { 
  const normalized = (value || "Unknown").replace(/\s+/g, " ").trim(); 
  if (normalized.length <= maxLength) { 
    return normalized;
  }

  return maxLength <= 3 ? normalized.slice(0, maxLength) : `${normalized.slice(0, maxLength - 3)}...`;
} 

function describeReadableQueueTrack(index: number, entry: QueueDisplayEntry) {
  const number = String(index).padStart(2, "0");
  const status = entry.status.padEnd(7, " ");
  const duration = formatDuration(entry.track.durationInSeconds).padStart(5, " ");
  const title = truncateQueueText(entry.track.title, 54);
  const artist = truncateQueueText(entry.track.artist || "Unknown artist", 34);
  const requester = truncateQueueText(entry.track.requestedBy || "Unknown listener", 28);

  return [
    `${number} | ${status} | ${duration} | ${title}`,
    `     Artist: ${artist}`,
    `     Added by: ${requester}`
  ].join("\n");
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

function parseSeekDurationInput(value: string | null | undefined) {
  const raw = value?.trim().toLowerCase();
  if (!raw) {
    return undefined;
  }

  const compact = raw.replace(/\s+/g, "");
  if (/^\d+$/.test(compact)) {
    return Number(compact);
  }

  const matches = [...compact.matchAll(/(\d+)([ms])/g)];
  if (!matches.length || matches.map((match) => match[0]).join("") !== compact) {
    return undefined;
  }

  return matches.reduce((total, match) => {
    const amount = Number(match[1]);
    return total + (match[2] === "m" ? amount * 60 : amount);
  }, 0);
}

function readSeekDurationInput(value: string | null | undefined, commandName: "fastforward" | "rewind") {
  const seconds = parseSeekDurationInput(value);
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0 || seconds > 600) {
    throw new Error(`Use \`${commandName} <duration>\`, like \`${commandName} 30s\`, \`${commandName} 1m\`, or \`${commandName} 1m30s\` (max 10m).`);
  }

  return seconds;
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
const queuePageSize = 6; 
const historyPageSize = 5;
const searchSessionTtlMs = 120_000;
const historyLookbackDays = 14;
const loginRetryDelaysMs = [5_000, 15_000, 30_000, 60_000, 120_000];
let responseSettingsMusic: MusicManager | undefined;

function getResponseSettings(guildId: string | null | undefined) {
  if (!guildId || !responseSettingsMusic) {
    return { privateResponsesPublic: false, autoDeleteBotResponses: true };
  }

  const settings = responseSettingsMusic.getGuildSettings(guildId);
  return {
    privateResponsesPublic: settings.privateResponsesPublic,
    autoDeleteBotResponses: settings.autoDeleteBotResponses
  };
}

function shouldSendPrivateResponse(guildId: string | null | undefined) {
  return !getResponseSettings(guildId).privateResponsesPublic;
}

function shouldAutoDeleteBotResponse(guildId: string | null | undefined) {
  return getResponseSettings(guildId).autoDeleteBotResponses;
}

function privateReplyOptions(guildId: string | null | undefined) {
  return shouldSendPrivateResponse(guildId) ? { ephemeral: true } : {};
}

function applyPrivateResponsePreference<T>(payload: T, guildId: string | null | undefined): T {
  if (typeof payload === "object" && payload !== null && "ephemeral" in payload) {
    const responsePayload = payload as T & { ephemeral?: boolean };
    if (responsePayload.ephemeral && !shouldSendPrivateResponse(guildId)) {
      return { ...responsePayload, ephemeral: false };
    }
  }

  return payload;
}

function getErrorStatus(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const status = "status" in error ? error.status : null;
  return typeof status === "number" ? status : null;
}

function isTransientLoginError(error: unknown) {
  const status = getErrorStatus(error);
  if (status !== null) {
    return status === 429 || status >= 500;
  }

  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return Boolean(code && ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(code));
  }

  return false;
}

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const botRestartExitCode = 42;

function scheduleBotRestart() {
  setTimeout(() => {
    process.exit(botRestartExitCode);
  }, 1_000);
}

async function loginWithRetry(client: Client) {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.login(appConfig.discordToken);
      return;
    } catch (error) {
      if (!isTransientLoginError(error)) {
        throw error;
      }

      const delayMs = loginRetryDelaysMs[Math.min(attempt, loginRetryDelaysMs.length - 1)];
      const status = getErrorStatus(error);
      console.warn(
        `[discord] login failed${status ? ` with HTTP ${status}` : ""}; retrying in ${Math.round(delayMs / 1000)} seconds`
      );
      await wait(delayMs);
    }
  }
}

interface SearchSession {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  query: string;
  results: SearchResult[];
}

const searchSessions = new Map<string, SearchSession>();

function searchSessionKey(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
}

interface PagedResponseSession {
  id: string;
  title: string;
  userId: string;
  pages: string[];
}

const pagedResponseSessions = new Map<string, PagedResponseSession>();

function createPagedResponseSession(title: string, userId: string, pages: string[]) {
  const session: PagedResponseSession = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    title,
    userId,
    pages
  };

  pagedResponseSessions.set(session.id, session);

  scheduleTimeout(() => {
    if (pagedResponseSessions.get(session.id)?.id === session.id) {
      pagedResponseSessions.delete(session.id);
    }
  }, searchSessionTtlMs);

  return session;
}

interface QueueDisplayEntry { 
  status: "Played" | "Now" | "Next"; 
  track: ResolvedTrack;  
}  
 
function buildQueueEntries(snapshot: ReturnType<MusicManager["getSnapshot"]>): QueueDisplayEntry[] { 
  const entries: QueueDisplayEntry[] = [];

  if (!snapshot.removeAfterPlayed) { 
    snapshot.played.forEach((track) => { 
      entries.push({ status: "Played", track }); 
    }); 
  } 
 
  if (snapshot.current) { 
    entries.push({ status: "Now", track: snapshot.current }); 
  } 
 
  snapshot.upcoming.forEach((track) => { 
    entries.push({ status: "Next", track }); 
  }); 

  return entries; 
} 

function describeQueueDisplayPositionStatus(status: QueueDisplayEntry["status"]) {
  return status === "Now" ? "the currently playing track" : "an already-played track";
}

function resolveUpcomingQueuePosition(
  snapshot: ReturnType<MusicManager["getSnapshot"]>,
  displayPosition: number,
  label = "queue position"
) {
  const entries = buildQueueEntries(snapshot);
  const entry = entries[displayPosition - 1];

  if (!entry) {
    throw new Error(`That ${label} does not exist in the queue view.`);
  }

  if (entry.status !== "Next") {
    throw new Error(
      `That ${label} points to ${describeQueueDisplayPositionStatus(entry.status)}. Choose a numbered upcoming track from /queue.`
    );
  }

  return entries.slice(0, displayPosition).filter((candidate) => candidate.status === "Next").length;
}

function formatQueueListLine(index: number, entry: QueueDisplayEntry) {
  return `${index}. **${entry.status}** **[${formatDuration(entry.track.durationInSeconds)}]** ${formatLinkedSongText(entry.track)}`;
}
 
function formatQueue(snapshot: ReturnType<MusicManager["getSnapshot"]>, page = 0) {   
  const entries = buildQueueEntries(snapshot);   
 
  if (!entries.length) {  
    return [  
      formatEmbedHeading("QUEUE"),  
      "", 
      "**Page:** 1 of 1", 
      "",  
      "No songs are queued right now."
    ].join("\n");  
  }  
 
  const pageCount = Math.max(1, Math.ceil(entries.length / queuePageSize)); 
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1); 
  const pageEntries = entries.slice(currentPage * queuePageSize, (currentPage + 1) * queuePageSize); 
  const pageStartIndex = currentPage * queuePageSize; 
 
  const lines = [    
    `**Page ${currentPage + 1}/${pageCount}**`,   
    "",     
    ...pageEntries.map((entry, index) => {   
      const number = pageStartIndex + index + 1;   
      return formatQueueListLine(number, entry);    
    })  
  ]; 

  if (pageCount > 1) {
    lines.push("", "Use the buttons below to change pages.");
  }

  return lines.join("\n");   
}   
  
function buildQueuePageButtons(guildId: string, userId: string, page: number, pageCount: number) {  
  return [  
    new ActionRowBuilder<ButtonBuilder>().addComponents( 
      new ButtonBuilder()  
        .setCustomId(`queue:${guildId}:${userId}:0:first`)  
        .setLabel("First")  
        .setStyle(ButtonStyle.Secondary)  
        .setDisabled(page <= 0),  
      new ButtonBuilder()  
        .setCustomId(`queue:${guildId}:${userId}:${Math.max(0, page - 1)}:previous`)  
        .setLabel("Previous")  
        .setStyle(ButtonStyle.Secondary)  
        .setDisabled(page <= 0),  
      new ButtonBuilder() 
        .setCustomId(`queue:${guildId}:${userId}:${page}:current`) 
        .setLabel(`Page ${page + 1} of ${pageCount}`) 
        .setStyle(ButtonStyle.Primary) 
        .setDisabled(true), 
      new ButtonBuilder()  
        .setCustomId(`queue:${guildId}:${userId}:${Math.min(pageCount - 1, page + 1)}:next`)  
        .setLabel("Next")  
        .setStyle(ButtonStyle.Secondary)  
        .setDisabled(page >= pageCount - 1), 
      new ButtonBuilder()  
        .setCustomId(`queue:${guildId}:${userId}:${pageCount - 1}:last`)  
        .setLabel("Last")  
        .setStyle(ButtonStyle.Secondary)  
        .setDisabled(page >= pageCount - 1)  
    ) 
  ]; 
} 

function buildQueuePayload(
  snapshot: ReturnType<MusicManager["getSnapshot"]>,
  userId: string,
  page = 0
) {
  const pageCount = Math.max(1, Math.ceil(buildQueueEntries(snapshot).length / queuePageSize));
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);

  return {
    ...embedTextPayload(formatQueue(snapshot, currentPage), { title: "Current Queue" }),
    components: buildQueuePageButtons(snapshot.guildId, userId, currentPage, pageCount)
  };
}

function buildQueueInteractionPayload(
  snapshot: ReturnType<MusicManager["getSnapshot"]>,
  userId: string,
  page = 0,
  ephemeral = false
) {
  return {
    ...buildQueuePayload(snapshot, userId, page),
    ...(ephemeral ? { ephemeral: true } : {})
  };
}

function formatSessionSettings(snapshot: ReturnType<MusicManager["getSnapshot"]>) {
  const playbackStatus = snapshot.current
    ? snapshot.isPaused ? "paused" : "playing"
    : snapshot.voiceChannelId ? "idle in voice" : "disconnected";

  return [
    formatEmbedHeading("SESSION SETTINGS"), 
    "",
    `**Playback:** ${playbackStatus}`, 
    `**Volume:** ${snapshot.volume}%`, 
    `**Filter:** ${snapshot.filterPreset}`, 
    `**Autoplay:** ${snapshot.autoplay ? "on" : "off"}`, 
    `**Vote skip:** ${snapshot.voteSkipEnabled ? "on" : "off"}`, 
    `**24/7 voice:** ${snapshot.stayInVoiceEnabled ? `on${snapshot.stayInVoiceById ? ` by <@${snapshot.stayInVoiceById}>` : ""}` : "off"}`,
    `**Solo session:** ${snapshot.soloSessionUserId ? `on by <@${snapshot.soloSessionUserId}>` : "off"}`,
    `**Already played:** ${snapshot.removeAfterPlayed ? "hidden" : "shown"}`, 
    `**Permission mode:** ${snapshot.permissionMode}`, 
    `**Session started:** ${snapshot.sessionStartedAt ? formatShortDateTime(snapshot.sessionStartedAt) : "none"}` 
  ].join("\n"); 
} 

function formatPremiumUsers(music: MusicManager) { 
  const users = music.listPremiumUsers();
  if (!users.length) {
    return "No Stripe premium subscriptions have been recorded yet.";
  }

  return users
    .map((user) => `- <@${user.userId}> - ${user.subscriptionStatus ?? "unknown"}${user.personalPrefix ? ` - prefix \`${user.personalPrefix}\`` : ""}`)
    .join("\n");
}

function formatShortDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function formatHistoryTrackLine(index: number, entry: PlaybackHistoryEntry) {
  const track = entry.track;
  const number = String(index + 1).padStart(2, "0");
  const duration = formatDuration(track.durationInSeconds).padStart(5, " ");
  const title = truncateQueueText(track.title, 54);
  const artist = truncateQueueText(track.artist || "Unknown artist", 34);
  const requester = truncateQueueText(track.requestedBy || "Unknown listener", 28);
  const channel = truncateQueueText(entry.voiceChannelName || "Unknown voice channel", 30);

  return [
    `${number} | ${duration} | ${title}`,
    `     Artist: ${artist}`,
    `     Played: ${formatShortDateTime(entry.playedAt)}`,
    `     Added by: ${requester}`,
    `     Voice: ${channel}`,
    `     Session started: ${formatShortDateTime(entry.sessionStartedAt)}`
  ].join("\n");
}

function formatHistoryPage(history: PlaybackHistoryEntry[], page = 0) {
  if (!history.length) { 
    return [ 
      formatEmbedHeading("HISTORY"),  
      "", 
      "**Page:** 1 of 1", 
      `**Window:** past ${historyLookbackDays} days`, 
      "", 
      "No songs have been recorded in this server."
    ].join("\n"); 
  } 

  const pageCount = Math.max(1, Math.ceil(history.length / historyPageSize));
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
  const pageEntries = history.slice(currentPage * historyPageSize, (currentPage + 1) * historyPageSize);
  const pageStartIndex = currentPage * historyPageSize;

  return [  
    `**Page ${currentPage + 1}/${pageCount}**`,  
    `Past ${historyLookbackDays} days`,  
    "",  
    ...pageEntries.map((entry, index) => { 
      return formatSongListLine(pageStartIndex + index + 1, entry.track);  
    }),  
    "",  
    "Use the buttons below to change pages."
  ].join("\n"); 
} 

function buildHistoryPageButtons(guildId: string, userId: string, page: number, pageCount: number) {
  if (pageCount <= 1) {
    return [];
  }

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder() 
        .setCustomId(`history:${guildId}:${userId}:0:first`) 
        .setLabel("First") 
        .setStyle(ButtonStyle.Secondary) 
        .setDisabled(page <= 0), 
      new ButtonBuilder() 
        .setCustomId(`history:${guildId}:${userId}:${Math.max(0, page - 1)}:previous`) 
        .setLabel("Previous") 
        .setStyle(ButtonStyle.Secondary) 
        .setDisabled(page <= 0), 
      new ButtonBuilder() 
        .setCustomId(`history:${guildId}:${userId}:${page}:current`) 
        .setLabel(`Page ${page + 1} of ${pageCount}`) 
        .setStyle(ButtonStyle.Primary) 
        .setDisabled(true), 
      new ButtonBuilder() 
        .setCustomId(`history:${guildId}:${userId}:${Math.min(pageCount - 1, page + 1)}:next`) 
        .setLabel("Next") 
        .setStyle(ButtonStyle.Secondary) 
        .setDisabled(page >= pageCount - 1), 
      new ButtonBuilder() 
        .setCustomId(`history:${guildId}:${userId}:${pageCount - 1}:last`) 
        .setLabel("Last") 
        .setStyle(ButtonStyle.Secondary) 
        .setDisabled(page >= pageCount - 1) 
    )
  ];
}

function buildHistoryPayload(
  history: PlaybackHistoryEntry[],
  guildId: string,
  userId: string,
  page = 0,
  ephemeral = false
) {
  const pageCount = Math.max(1, Math.ceil(history.length / historyPageSize));
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);

  return {
    ...embedTextPayload(formatHistoryPage(history, currentPage), { title: "Song History" }),
    components: buildHistoryPageButtons(guildId, userId, currentPage, pageCount),
    ...(ephemeral ? { ephemeral: true } : {})
  };
}

function buildPagedResponseButtons(session: PagedResponseSession, page: number) {
  const pageCount = session.pages.length;
  if (pageCount <= 1) {
    return [];
  }

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder() 
        .setCustomId(`page:${session.id}:${session.userId}:0:first`) 
        .setLabel("First") 
        .setStyle(ButtonStyle.Secondary) 
        .setDisabled(page <= 0), 
      new ButtonBuilder() 
        .setCustomId(`page:${session.id}:${session.userId}:${Math.max(0, page - 1)}:previous`) 
        .setLabel("Previous") 
        .setStyle(ButtonStyle.Secondary) 
        .setDisabled(page <= 0), 
      new ButtonBuilder() 
        .setCustomId(`page:${session.id}:${session.userId}:${page}:current`) 
        .setLabel(`Page ${page + 1} of ${pageCount}`) 
        .setStyle(ButtonStyle.Primary) 
        .setDisabled(true), 
      new ButtonBuilder() 
        .setCustomId(`page:${session.id}:${session.userId}:${Math.min(pageCount - 1, page + 1)}:next`) 
        .setLabel("Next") 
        .setStyle(ButtonStyle.Secondary) 
        .setDisabled(page >= pageCount - 1), 
      new ButtonBuilder() 
        .setCustomId(`page:${session.id}:${session.userId}:${pageCount - 1}:last`) 
        .setLabel("Last") 
        .setStyle(ButtonStyle.Secondary) 
        .setDisabled(page >= pageCount - 1) 
    )
  ];
}

function buildPagedResponsePayload(session: PagedResponseSession, page = 0, ephemeral = false) {
  const pageCount = Math.max(1, session.pages.length);
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);

  return {
    ...embedTextPayload(session.pages[currentPage] ?? session.pages[0] ?? "No response content.", { title: session.title }),
    components: buildPagedResponseButtons(session, currentPage),
    ...(ephemeral ? { ephemeral: true } : {})
  };
}

function formatPrefixList(prefixes: string[]) {
  return prefixes.map((prefix) => `\`${prefix}\``).join(", ");
}

function formatEmbedHeading(title: string) {
  return `# __**${title}**__`;
}

function formatSectionHeading(title: string) {
  return `## __**${title}**__`;
}

function formatHelpCommand(command: string, description: string) {    
  const leaderLength = Math.max(2, 16 - command.length);   
  const styledCommand = command
    .split(/(<[^>]+>)/g)
    .filter(Boolean)
    .map((part) => part.startsWith("<") && part.endsWith(">") ? `_${part}_` : `**${part}**`)
    .join("");

  return `${styledCommand}${"-".repeat(leaderLength)} \`${description.replace(/`/g, "\\`")}\``; 
} 

function formatBotHelp(prefixes: string[]) {
  const primaryPrefix = prefixes[0] ?? ";";
 
  return [ 
    formatEmbedHeading("HELP"),  
    "", 
    `**Text Prefixes:** ${formatPrefixList(prefixes)}`, 
    "**Slash Commands also work.**", 
    "",  
    formatSectionHeading("START"),   
    formatHelpCommand("/join", "Join voice"),  
    formatHelpCommand("/play <song>", "Queue song/link"),  
    formatHelpCommand(`${primaryPrefix}play <song>`, "Same as /play"),  
    "",  
    formatSectionHeading("QUEUE"),   
    formatHelpCommand("/queue", "Show queue"),  
    formatHelpCommand("/history", "Recent songs"),  
    "",  
    formatSectionHeading("CONTROL"),   
    formatHelpCommand("/pause", "Pause playback"),  
    formatHelpCommand("/resume", "Resume playback"),  
    formatHelpCommand("/skip", "Skip song"),  
    formatHelpCommand("/restart", "Restart song"),  
    formatHelpCommand("/stop", "Stop + clear queue"),  
    formatHelpCommand("/disconnect", "Leave voice"),  
    formatHelpCommand("/fix", "Repair player"),  
    "",  
    formatSectionHeading("MORE"),    
    formatHelpCommand("/search <query>", "Search songs"),   
    formatHelpCommand("/lyrics [query]", "Find lyrics"),   
    formatHelpCommand("/commands", "Command list")   
  ].join("\n");  
}  

function formatCommandCheatSheet(prefixes: string[]) {
  const prefix = prefixes[0] ?? ";";
 
  return [ 
    formatEmbedHeading("COMMANDS"),  
    "", 
    `**Text Prefixes:** ${formatPrefixList(prefixes)}`, 
    "**Slash Commands also work.**", 
    "", 
    formatSectionHeading("PLAYBACK"),   
    formatHelpCommand(`/join`, `${prefix}join`),  
    formatHelpCommand(`/play <song>`, `${prefix}play <song>`),  
    formatHelpCommand(`/play-file <file>`, `${prefix}play + attach`),  
    formatHelpCommand(`/insert <song>`, `${prefix}insert <song>`),  
    formatHelpCommand(`/pause`, `${prefix}pause`), 
    formatHelpCommand(`/resume`, `${prefix}resume`), 
    formatHelpCommand(`/skip [to]`, `${prefix}skip [#]`),    
    formatHelpCommand(`/restart`, `${prefix}restart`),   
    formatHelpCommand(`/fastforward <duration>`, `${prefix}ff 1m30s`), 
    formatHelpCommand(`/rewind <duration>`, `${prefix}rew 30s`), 
    formatHelpCommand(`/stop`, `${prefix}stop`),   
    formatHelpCommand(`/disconnect`, `${prefix}disconnect`),    
    "",  
    formatSectionHeading("QUEUE"),   
    formatHelpCommand(`/queue`, `${prefix}queue`), 
    formatHelpCommand(`/history`, `${prefix}history`), 
    formatHelpCommand(`/clear`, `${prefix}clear`), 
    formatHelpCommand(`/remove <#>`, `${prefix}remove [#]`),   
    formatHelpCommand(`/move <from> <to>`, `${prefix}move [#] [#]`),   
    formatHelpCommand(`/removelast`, `${prefix}removelast`), 
    formatHelpCommand(`/removeduplicates`, `${prefix}removeduplicates`), 
    formatHelpCommand(`/removeabsent`, `${prefix}removeabsent`), 
    formatHelpCommand(`/massremove <start> <count>`, `${prefix}massremove [#] <count>`),   
    formatHelpCommand(`/removeafterplayed`, `${prefix}removeafterplayed on/off`), 
    "", 
    formatSectionHeading("TOOLS"),  
    formatHelpCommand(`/search <query>`, `${prefix}search <query>`), 
    formatHelpCommand(`/lyrics [query]`, `${prefix}lyrics [query]`), 
    formatHelpCommand(`/save`, `${prefix}save`), 
    formatHelpCommand(`/fix`, `${prefix}fix`), 
    formatHelpCommand(`/help`, `${prefix}help`), 
    formatHelpCommand(`/commands`, `${prefix}commands`), 
    "",  
    formatSectionHeading("SETTINGS"),   
    formatHelpCommand(`/filter <preset>`, `${prefix}filter <preset>`),   
    formatHelpCommand(`/autoplay on/off`, `${prefix}autoplay on/off`),   
    formatHelpCommand(`/prefix self <set|remove|show>`, `${prefix}prefix self <set|remove|show>`),
    formatHelpCommand(`/solo <on|off>`, `${prefix}solo <on|off>`),
    formatHelpCommand(`/247 <on|off>`, `${prefix}247 <on|off>`),
    formatHelpCommand(`/subscribe`, `${prefix}subscribe`),
    formatHelpCommand(`/sessionsettings`, `${prefix}sessionsettings`)   
  ].join("\n");   
}   

function formatAutoFixResult(result: { applied: boolean; actions: string[] }) {
  return [
    formatEmbedHeading("AUTO FIX"), 
    "",
    `**Status:** ${result.applied ? "Auto-fix ran." : "Auto-fix check completed."}`,
    "",
    formatSectionHeading("ACTIONS"), 
    ...result.actions.map((action, index) => `**${index + 1}.** ${action}`) 
  ].join("\n"); 
} 
 
function formatSearchResults(query: string, results: SearchResult[]) { 
  if (!results.length) { 
    return [ 
      formatEmbedHeading("SEARCH RESULTS"),  
      "", 
      `**Query:** ${truncateQueueText(query, 70)}`, 
      "", 
      "No results found."
    ].join("\n"); 
  } 

  const visibleResults = results.slice(0, 10);

  return [  
    "**Search Results**",  
    `**Query:** ${truncateQueueText(query, 70)}`,  
    "",  
    ...visibleResults.map((result, index) => {  
      return formatSongListLine(index + 1, result);  
    }),  
    "",  
    "Use the dropdown below, or type the result number."
  ].join("\n"); 
} 

function createSearchSession(guildId: string, channelId: string, userId: string, query: string, results: SearchResult[]) {
  const session: SearchSession = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    guildId,
    channelId,
    userId,
    query,
    results
  };
  const key = searchSessionKey(guildId, userId);
  searchSessions.set(key, session);

  scheduleTimeout(() => {
    if (searchSessions.get(key)?.id === session.id) {
      searchSessions.delete(key);
    }
  }, searchSessionTtlMs);

  return session;
}

function buildSearchSelectPayload(session: SearchSession) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`search:${session.guildId}:${session.userId}:${session.id}`)
    .setPlaceholder("Choose the song to queue")
    .addOptions(
      session.results.slice(0, 10).map((result, index) => ({
        label: truncateQueueText(`${index + 1}. ${result.title}`, 100),
        description: truncateQueueText(
          [result.artist || "Unknown artist", formatDuration(result.durationInSeconds)].join(" | "),
          100
        ),
        value: String(index)
      }))
    );

  return {
    ...embedTextPayload(
      [
        formatSearchResults(session.query, session.results),
        "",
        "Select a result from the dropdown, or type its number in chat."
      ].join("\n"),
      { title: "Search Results" }
    ),
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)]
  };
}

function formatQueuedSearchResult(result: SearchResult) {  
  return [ 
    formatEmbedHeading("QUEUED TRACK"), 
    "", 
    formatSongListLine(1, result) 
  ].join("\n");  
}  

function formatAutocompleteResult(result: SearchResult) {
  return truncateQueueText(
    [
      result.title,
      result.artist ? `by ${result.artist}` : undefined,
      formatDuration(result.durationInSeconds)
    ].filter(Boolean).join(" | "),
    100
  );
}

function takeSearchSession(guildId: string, userId: string, sessionId?: string) {
  const key = searchSessionKey(guildId, userId);
  const session = searchSessions.get(key);
  if (!session || (sessionId && session.id !== sessionId)) {
    return undefined;
  }

  searchSessions.delete(key);
  return session;
}

function readSearchChoice(message: Message) {
  const normalized = message.content.trim();
  return /^\d{1,2}$/.test(normalized) ? Number.parseInt(normalized, 10) : undefined;
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

function escapeMarkdownLinkText(value: string) {
  return value.replace(/[[\]\\]/g, "\\$&");
}

function formatLinkedSongText(input: { title: string; artist?: string; url?: string; playbackUrl?: string }) {
  const label = `${input.title}${input.artist ? ` by ${input.artist}` : ""}`;
  const url = isHttpUrl(input.playbackUrl) 
    ? input.playbackUrl 
    : isHttpUrl(input.url) ? input.url : undefined; 
 
  return url ? `[${escapeMarkdownLinkText(label)}](${url})` : label; 
} 

function buildQueuedTrackPayload(track: ResolvedTrack) {  
  const embed = new EmbedBuilder() 
    .setColor(0x57f287) 
    .setDescription([
      formatEmbedHeading("QUEUED TRACK"),
      "",
      `**${formatLinkedSongText(track)}**`
    ].join("\n"))
    .addFields( 
      { name: "Artist", value: track.artist || "Unknown artist", inline: true }, 
      { name: "Duration", value: formatDuration(track.durationInSeconds), inline: true }, 
      { name: "Added by", value: track.requestedById ? `<@${track.requestedById}>` : (track.requestedBy || "Unknown listener"), inline: true } 
    ) 
    .setTimestamp(); 

  if (isHttpUrl(track.artwork)) {
    embed.setThumbnail(track.artwork ?? null);
  }

  return { embeds: [embed] };
}

function formatSongListLine( 
  index: number, 
  input: { title: string; artist?: string; durationInSeconds?: number; url?: string; playbackUrl?: string } 
) { 
  return `${index}. **[${formatDuration(input.durationInSeconds)}]** ${formatLinkedSongText(input)}`; 
} 

function formatPlaylistSummary(playlist: Playlist, showOwner = false) { 
  const owner = showOwner ? ` by <@${playlist.createdById}>` : ""; 
  return `- **${playlist.name}**${owner} (${playlist.tracks.length})`; 
} 

function formatPlaylistTracks(playlist: Playlist, showOwner = false) { 
  const header = [
    `**${playlist.name}**${showOwner ? ` by <@${playlist.createdById}>` : ""}`,
    `${playlist.tracks.length} track${playlist.tracks.length === 1 ? "" : "s"}`
  ].join(" - "); 

  if (!playlist.tracks.length) { 
    return `${header}\nNo songs saved in this shock-list yet.`; 
  } 

  return [
    header,
    "",
    ...playlist.tracks.slice(0, 25).map((track, index) => formatSongListLine(index + 1, track)),
    ...(playlist.tracks.length > 25 ? [`...and ${playlist.tracks.length - 25} more.`] : [])
  ].join("\n"); 
} 

function splitNameAndTrailingLink(value: string, usage: string) { 
  const match = value.match(/\s+(https?:\/\/\S+)\s*$/i); 
  if (!match?.[1]) { 
    throw new Error(usage); 
  } 

  const name = value.slice(0, match.index).trim(); 
  if (!name) { 
    throw new Error(usage); 
  } 

  return { name, link: match[1] }; 
} 

function readMentionOrId(value: string | undefined, usage: string) { 
  const id = value?.match(/\d{15,25}/)?.[0]; 
  if (!id) { 
    throw new Error(usage); 
  } 

  return id; 
} 

function formatNowPlayingTrack(track: ResolvedTrack) { 
  return `**${formatLinkedSongText(track)}**`; 
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

const prefixCommandAliases: Record<string, string> = {
  p: "play",
  s: "skip",
  rew: "rewind",
  ff: "fastforward", 
  mod: "moderation", 
  pl: "shock-list", 
  playlist: "shock-list", 
  shocklist: "shock-list", 
  sl: "shock-list", 
  list: "shock-list", 
  shock: "shock-list", 
  shockl: "shock-list", 
  mremove: "massremove", 
  mr: "massremove",
  mrem: "massremove",
  r: "remove",
  rem: "remove",
  res: "restart", 
  unpause: "resume", 
  go: "resume", 
  rb: "reboot", 
  rboot: "reboot", 
  boot: "reboot", 
  lavab: "lavaboot", 
  lboot: "lavaboot", 
  lb: "lavaboot", 
  in: "insert",
  i: "insert",
  next: "insert",
  m: "move",
  dis: "disconnect", 
  leave: "disconnect", 
  byebye: "disconnect", 
  fuckoff: "disconnect", 
  adios: "disconnect", 
  vol: "volume",
  v: "volume",
  rl: "removelast",
  reml: "removelast",
  rlast: "removelast",
  removel: "removelast",
  remlast: "removelast",
  rd: "removeduplicates",
  remd: "removeduplicates",
  rduplicates: "removeduplicates",
  removed: "removeduplicates",
  remdup: "removeduplicates",
  removedup: "removeduplicates",
  remduplicates: "removeduplicates",
  ra: "removeabsent",
  rema: "removeabsent",
  rabsent: "removeabsent",
  removea: "removeabsent",
  removeabs: "removeabsent",
  remabs: "removeabsent",
  remabsent: "removeabsent",
  settings: "sessionsettings",
  serversettings: "sessionsettings",
  h: "help", 
  cmds: "commands",  
  commandlist: "commands",  
  prem: "premium", 
  paid: "premium", 
  "premium subscribe": "subscribe",
  "premium solo": "solo",
  "premium vc247": "247",
  "premium 247": "247",
  vc247: "247",
  "24/7": "247",
  sc: "synccommands",  
  sync: "synccommands", 
  scommands: "synccommands", 
  autofix: "fix",   
  f: "fix",  
  q: "queue", 
  np: "nowplaying"
};

function normalizeCommandName(value: string) {
  const normalized = value.trim().toLowerCase().replace(/^\//, "");
  return prefixCommandAliases[normalized] ?? normalized;
}

function parsePrefixCommandInput(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const twoWordAlias = parts.slice(0, 2).join(" ").toLowerCase();
  if (twoWordAlias && prefixCommandAliases[twoWordAlias]) {
    return {
      command: prefixCommandAliases[twoWordAlias],
      rest: parts.slice(2)
    };
  }

  return {
    command: parts[0] ? normalizeCommandName(parts[0]) : undefined,
    rest: parts.slice(1)
  };
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
    formatEmbedHeading("MODERATION"),  
    "", 
    `**Disabled commands:** ${disabledCommands}`,  
    `**Private responses:** ${settings.privateResponsesPublic ? "public" : "private"}`,  
    `**Auto-delete:** ${settings.autoDeleteBotResponses ? "on" : "off"}`,  
    `**Max song length:** ${settings.maxSongLengthSeconds ? `${settings.maxSongLengthSeconds}s` : "off"}`,  
    `**Max shock-list length:** ${settings.maxPlaylistLength ? `${settings.maxPlaylistLength} tracks` : "off"}`,  
    "", 
    formatSectionHeading("CHANNEL OVERRIDES"),  
    channelLines, 
    "", 
    formatSectionHeading("MEMBER OVERRIDES"),  
    memberLines
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

function scheduleMessageDeletion(
  target: { delete: () => Promise<unknown> } | null | undefined,
  guildId?: string | null
) {
  if (!target || commandDeleteDelayMs <= 0 || !shouldAutoDeleteBotResponse(guildId)) {
    return;
  }

  scheduleTimeout(() => {
    void target.delete().catch(() => undefined);
  }, commandDeleteDelayMs);
}

function scheduleInteractionReplyDeletion(interaction: ChatInputCommandInteraction) {
  if (
    commandDeleteDelayMs <= 0
    || !shouldAutoDeleteBotResponse(interaction.guildId)
    || interaction.ephemeral
    || (!interaction.deferred && !interaction.replied)
  ) {
    return;
  }

  scheduleTimeout(() => {
    void interaction.deleteReply().catch(() => undefined);
  }, commandDeleteDelayMs);
}

async function replyAndAutoDelete(message: Message, payload: string | MessageReplyOptions) {
  const reply = await message.reply(withMessageEmbedPayload(payload));
  scheduleMessageDeletion(reply, message.guildId);
  return reply;
}

async function replyWithoutAutoDelete(message: Message, payload: string | MessageReplyOptions) { 
  return message.reply(withMessageEmbedPayload(payload)); 
} 
 
async function editMessageReply(reply: Message, payload: string, title = BOT_BRAND_NAME) { 
  await reply.edit(embedTextPayload(payload, { title })); 
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
  await interaction.reply(applyPrivateResponsePreference(withInteractionReplyEmbedPayload(payload, title), interaction.guildId));
}

async function editInteractionReply(
  interaction: ChatInputCommandInteraction,
  payload: string | InteractionEditReplyOptions,
  title = BOT_BRAND_NAME
) {
  await interaction.editReply(applyPrivateResponsePreference(withInteractionEditEmbedPayload(payload, title), interaction.guildId));
}

async function followUpInteraction(
  interaction: ChatInputCommandInteraction,
  payload: string | InteractionReplyOptions,
  title = BOT_BRAND_NAME,
  autoDelete = true
) {
  const followUp = await interaction.followUp(
    applyPrivateResponsePreference(withInteractionReplyEmbedPayload(payload, title), interaction.guildId)
  );
  if (autoDelete) {
    scheduleMessageDeletion("delete" in followUp ? followUp : undefined, interaction.guildId);
  }
  return followUp;
}


async function sendChunkedMessage(message: Message, chunks: string[], title: string) {
  const [firstChunk, ...restChunks] = chunks;
  if (!firstChunk) {
    return;
  }

  if (!restChunks.length) {
    await message.reply(withMessageEmbedPayload(firstChunk, title));
    return;
  }

  const session = createPagedResponseSession(title, message.author.id, chunks);
  await message.reply(buildPagedResponsePayload(session));
}

async function sendChunkedInteraction(
  interaction: ChatInputCommandInteraction,
  chunks: string[],
  title: string
) {
  const [firstChunk, ...restChunks] = chunks;
  if (!firstChunk) {
    return;
  }

  if (restChunks.length) {
    const session = createPagedResponseSession(title, interaction.user.id, chunks);
    const payload = buildPagedResponsePayload(session, 0, true);
    if (interaction.replied) {
      await followUpInteraction(interaction, payload, title, false);
    } else if (interaction.deferred) {
      await editInteractionReply(interaction, payload);
    } else {
      await replyToInteraction(interaction, payload);
    }
    return;
  }

  if (interaction.replied) {
    await followUpInteraction(interaction, { content: firstChunk, ephemeral: true }, title, false);
  } else if (interaction.deferred) {
    await editInteractionReply(interaction, firstChunk, title);
  } else {
    await replyToInteraction(interaction, { content: firstChunk, ephemeral: true }, title);
  }
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

async function reportComponentError(interaction: ButtonInteraction | StringSelectMenuInteraction, error: unknown) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const payload = applyPrivateResponsePreference(
    { ...embedTextPayload(message, { title: BOT_ERROR_TITLE, tone: "error" }), ephemeral: true },
    interaction.guildId
  );

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
      return;
    }

    await interaction.reply(payload);
  } catch (replyError) {
    console.error("[component] failed to send error response", replyError);
  }
}

async function handleAutocomplete(interaction: AutocompleteInteraction, music: MusicManager) {
  if (interaction.commandName !== "play") {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  const query = String(focused.value ?? "").trim();
  if (focused.name !== "song" || query.length < 2 || isHttpUrl(query)) {
    await interaction.respond([]);
    return;
  }

  try {
    const results = await Promise.race([
      music.search(query, 10),
      new Promise<SearchResult[]>((resolve) => {
        setTimeout(() => resolve([]), 2_500).unref?.();
      })
    ]);

    await interaction.respond(
      results.slice(0, 10).map((result) => ({
        name: formatAutocompleteResult(result),
        value: truncateQueueText(result.url, 100)
      }))
    );
  } catch (error) {
    console.warn(`[autocomplete:play] failed for query "${query}"`, error);
    await interaction.respond([]);
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
  if (music.hasBotManagementAccess(interaction.user.id)) { 
    return; 
  } 
 
  throw new Error("Only configured bot owners or bot managers can use that command."); 
} 

function summarizeProcessOutput(value: string) {  
  const lines = value 
    .split(/\r?\n/) 
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-4).join("\n"); 
} 
 
function formatErrorMessage(error: unknown) { 
  return error instanceof Error ? error.message : "Something went wrong."; 
} 
 
async function restartLocalLavalink() { 
  const scriptPath = join(process.cwd(), "lavalink", "restart-lavalink.ps1");
  if (!existsSync(scriptPath)) {
    throw new Error("Lavalink restart script is missing at `lavalink/restart-lavalink.ps1`.");
  }

  return new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      {
        cwd: join(process.cwd(), "lavalink"),
        timeout: 120000,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const output = summarizeProcessOutput(`${stdout}\n${stderr}`);
        if (error) {
          reject(new Error(output || error.message));
          return;
        }

        resolve(output || "Restart script completed.");
      }
    );
  });
}

function formatAllPlaylists(playlists: Playlist[]) {  
  return playlists.length  
    ? playlists.map((playlist) => formatPlaylistSummary(playlist, true)).join("\n")  
    : "No saved shock-lists exist yet.";  
}  
 
function isNowPlayingEmbedMessage(message: Message, botUserId: string) {
  return message.author.id === botUserId
    && message.embeds.some((embed) => embed.title?.trim().toLowerCase() === "now playing");
}

function isKnownPrefixCommandMessage(message: Message, music: MusicManager) {
  if (!message.guildId || message.author.bot) {
    return false;
  }

  const prefix = music.findMatchingPrefix(message.guildId, message.content, message.author.id);
  if (!prefix) {
    return false;
  }

  const { command } = parsePrefixCommandInput(message.content.slice(prefix.length));
  return Boolean(command && knownCommandNames.has(command));
}

function isKnownSlashCommandMessage(message: Message, botUserId: string) {
  return !message.author.bot
    && message.type === MessageType.ChatInputCommand
    && message.applicationId === botUserId;
}

function shouldCleanMessage(message: Message, music: MusicManager, botUserId: string) {
  if (isNowPlayingEmbedMessage(message, botUserId)) {
    return false;
  }

  return message.author.id === botUserId
    || isKnownPrefixCommandMessage(message, music)
    || isKnownSlashCommandMessage(message, botUserId);
}

async function cleanBotMessages(message: Message | ChatInputCommandInteraction, music: MusicManager, amount = 50) { 
  const channel = message.channel;
  if (!channel || !channel.isTextBased() || !("messages" in channel) || !("bulkDelete" in channel)) {
    throw new Error("Clean only works in guild text chats, including voice call chats.");
  }

  const botUserId = message.client.user?.id;
  if (!botUserId) {
    throw new Error("The bot user is not ready yet.");
  }

  const fetched = await channel.messages.fetch({ limit: Math.min(100, amount) });
  const cleanableMessages = fetched.filter((entry) => shouldCleanMessage(entry, music, botUserId)).first(100);

  if (!cleanableMessages.length) {
    return 0;
  }

  await channel.bulkDelete(cleanableMessages, true);
  return cleanableMessages.length;
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

  if (restChunks.length) {
    const session = createPagedResponseSession("Lyrics", interaction.user.id, chunks);
    const payload = buildPagedResponsePayload(session, 0, false);
    if (interaction.replied) {
      await followUpInteraction(interaction, payload, "Lyrics", false);
    } else if (interaction.deferred) {
      await editInteractionReply(interaction, payload);
    } else {
      await replyToInteraction(interaction, payload);
    }
    return;
  }

  if (interaction.replied) {
    await followUpInteraction(interaction, firstChunk, "Lyrics", false);
  } else if (interaction.deferred) {
    await editInteractionReply(interaction, firstChunk, "Lyrics");
  } else {
    await replyToInteraction(interaction, firstChunk, "Lyrics");
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

  if (restChunks.length) {
    const session = createPagedResponseSession("Lyrics", message.author.id, chunks);
    await message.reply(buildPagedResponsePayload(session));
    return;
  }

  await message.reply(withMessageEmbedPayload(firstChunk, "Lyrics"));
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
    await sendChunkedInteraction(interaction, chunks, "Lyrics");
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
  responseSettingsMusic = music;

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
    void music.holdPlayersForShardInterruption(shardId).catch((error) => {
      console.error(`[discord] failed to pause players for shard ${shardId} disconnect`, error);
    });
  }); 

  client.on(Events.ShardReconnecting, (shardId) => { 
    console.warn(`[discord] shard ${shardId} reconnecting`); 
    void music.holdPlayersForShardInterruption(shardId).catch((error) => {
      console.error(`[discord] failed to pause players for shard ${shardId} reconnect`, error);
    });
  }); 

  client.on(Events.ShardResume, (shardId, replayedEvents) => { 
    console.log(`[discord] shard ${shardId} resumed with ${replayedEvents} replayed event${replayedEvents === 1 ? "" : "s"}`); 
    void music.releasePlayersForShardInterruption(shardId).catch((error) => {
      console.error(`[discord] failed to resume players for shard ${shardId}`, error);
    });
  }); 

  client.on(Events.ChannelUpdate, (oldChannel, newChannel) => {
    if (!("guild" in oldChannel) || !("guild" in newChannel)) {
      return;
    }

    void music.recordVoiceChannelUpdate(oldChannel, newChannel).catch((error) => {
      console.error(`[voice:${newChannel.id}] failed to handle voice channel update`, error);
    });
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => { 
    void music.recordVoiceStateChange(oldState, newState).catch((error) => { 
      console.error(`[voice:${newState.guild.id}] failed to record voice state change`, error);
    });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith("page:")) {
      try {
        await handlePagedResponseButton(interaction);
      } catch (error) {
        console.error("[component:page]", error);
        await reportComponentError(interaction, error);
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("history:")) {
      try {
        await handleHistoryPageButton(interaction, music);
      } catch (error) {
        console.error("[component:history]", error);
        await reportComponentError(interaction, error);
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("queue:")) {
      try {
        await handleQueuePageButton(interaction, music);
      } catch (error) {
        console.error("[component:queue]", error);
        await reportComponentError(interaction, error);
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("search:")) {
      try {
        await handleSearchSelect(interaction, music);
      } catch (error) {
        console.error("[component:search]", error);
        await reportComponentError(interaction, error);
      }
      return;
    }

    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, music);
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      await handleSlashCommand(interaction, music, lyrics);
      if (!["help", "commands", "history", "lyrics"].includes(interaction.commandName)) {
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

    if (await maybeQueueSearchNumberChoice(message, music)) {
      return;
    }

    const prefix = music.findMatchingPrefix(message.guild.id, message.content, message.author.id);
    if (!prefix) {
      return;
    }

    const { command, rest } = parsePrefixCommandInput(message.content.slice(prefix.length));
    const query = rest.join(" ").trim();

    try {
      if (command && knownCommandNames.has(command)) {
        scheduleMessageDeletion(message);
        const member = await message.guild.members.fetch(message.author.id);
        await music.assertCanUseCommand(member, message.guild.id, command, message.channelId);
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
              : buildQueuedTrackPayload(track) 
          ); 
          return;
        }
        case "play-file":
          throw new Error(`Use \`${music.getPrefix(message.guild.id)}play\` with an uploaded audio or video file.`);
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
          await replyAndAutoDelete(message, buildQueuedTrackPayload(track)); 
          return;
        }
        case "skip": 
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id); 
          if (rest[0]) { 
            const skipTarget = Number.parseInt(rest[0], 10); 
            if (!Number.isInteger(skipTarget)) { 
              throw new Error("Use `skip` or `skip <queue position>`."); 
            } 
            const queuePosition = resolveUpcomingQueuePosition(music.getSnapshot(message.guild.id), skipTarget); 
            await music.skipTo(message.guild.id, queuePosition); 
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
            throw new Error(`Use \`${music.getPrefix(message.guild.id)}move <from> <to>\`.`); 
          } 

          const snapshot = music.getSnapshot(message.guild.id); 
          const fromQueuePosition = resolveUpcomingQueuePosition(snapshot, from, "source position"); 
          const toQueuePosition = resolveUpcomingQueuePosition(snapshot, to, "target position"); 
          const moved = await music.move(message.guild.id, fromQueuePosition, toQueuePosition); 
          await replyAndAutoDelete(message, `Moved **${moved.title}** from #${from} to #${to}.`); 
          return; 
        } 
        case "search": {
          if (!query) throw new Error(`Provide search terms like \`${music.getPrefix(message.guild.id)}search artists and songs\`.`);
          const results = await music.search(query);
          if (!results.length) {
            await replyAndAutoDelete(message, formatSearchResults(query, results));
            return;
          }

          const session = createSearchSession(message.guild.id, message.channelId, message.author.id, query, results);
          await replyAndAutoDelete(message, buildSearchSelectPayload(session));
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
          music.assertPremiumOrBotManagementUser(message.author.id);
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
          await replyAndAutoDelete(message, buildQueuePayload(music.getSnapshot(message.guild.id), message.author.id));
          return;
        case "history": 
          await replyWithoutAutoDelete( 
            message, 
            buildHistoryPayload( 
              music.getSongHistory(message.guild.id, historyLookbackDays), 
              message.guild.id,
              message.author.id
            )
          );
          return;
        case "help": 
          await replyWithoutAutoDelete(message, formatBotHelp(music.getPrefixes(message.guild.id))); 
          return; 
        case "commands": 
          await replyWithoutAutoDelete(message, formatCommandCheatSheet(music.getPrefixes(message.guild.id))); 
          return; 
        case "fix": {
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          const result = await music.autoFix(message.guild.id);
          await replyAndAutoDelete(message, formatAutoFixResult(result));
          return;
        }
        case "restart": {
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          const track = await music.restartCurrent(message.guild.id);
          await replyAndAutoDelete(message, `Restarted **${track.title}**.`);
          return;
        } 
        case "reboot": {   
          if (!music.hasBotManagementAccess(message.author.id)) {   
            throw new Error("Only configured bot owners or bot managers can use that command.");   
          }   
  
          const reply = await replyWithoutAutoDelete(message, "Reboot requested. Preparing to restart the bot process."); 
          await editMessageReply(reply, "Bot restart scheduled. The process will exit in 1 second and the local launcher will bring it back.", "Rebooting"); 
          scheduleMessageDeletion(reply, message.guildId); 
          scheduleBotRestart();  
          return;  
        }   
        case "lavaboot": {   
          if (!music.hasBotManagementAccess(message.author.id)) {   
            throw new Error("Only configured bot owners or bot managers can use that command.");   
          }   
   
          const reply = await replyWithoutAutoDelete(message, "Lavalink restart requested. Looking for the local Lavalink process now."); 
          try { 
            const output = await restartLocalLavalink();  
            await editMessageReply(reply, `Lavalink restart completed.\n${output}`, "LavaBoot"); 
          } catch (error) { 
            await editMessageReply(reply, `Lavalink restart failed.\n${formatErrorMessage(error)}`, "LavaBoot"); 
          } 
          scheduleMessageDeletion(reply, message.guildId); 
          return;  
        }  
        case "synccommands": { 
          if (!music.hasBotManagementAccess(message.author.id)) { 
            throw new Error("Only configured bot owners or bot managers can use that command."); 
          } 
 
          await registerCommands(); 
          await replyAndAutoDelete( 
            message, 
            `Slash commands re-registered using ${appConfig.discordGuildId ? "guild" : "global"} scope.` 
          ); 
          return; 
        } 
        case "removeafterplayed": {  
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id); 
          const enabled = parseToggleValue(rest[0]); 
          if (enabled === undefined) {
            throw new Error("Use `removeafterplayed <on|off>`.");
          }
          const removeAfterPlayed = await music.toggleRemoveAfterPlayed(message.guild.id, enabled);
          await replyAndAutoDelete(
            message,
            `Already-played songs are now ${removeAfterPlayed ? "hidden from" : "shown in"} the queue view.`
          );
          return;
        }
        case "sessionsettings":
          await replyAndAutoDelete(message, formatSessionSettings(music.getSnapshot(message.guild.id)));
          return;
        case "nowplaying":
        case "np": {
          const current = music.getSnapshot(message.guild.id).current;
          await replyAndAutoDelete(message, current ? formatNowPlayingTrack(current) : "Nothing is playing.");
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
          await replyAndAutoDelete(message, "Stopped playback and cleared the queue.");
          return;
        case "disconnect":
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          await music.disconnect(message.guild.id);
          await replyAndAutoDelete(message, "Disconnected from voice.");
          return;
        case "clear":
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id);
          await music.clearQueue(message.guild.id);
          await replyAndAutoDelete(message, "Queue cleared.");
          return;
        case "volume": {
          await ensureModeratorGuildMember(await message.guild.members.fetch(message.author.id), music);
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

          const queuePosition = resolveUpcomingQueuePosition(music.getSnapshot(message.guild.id), index); 
          const removed = await music.remove(message.guild.id, queuePosition); 
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

          const queuePosition = resolveUpcomingQueuePosition(music.getSnapshot(message.guild.id), start, "start position"); 
          const removedCount = await music.massRemove(message.guild.id, queuePosition, count); 
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
          const seconds = readSeekDurationInput(rest.join(" "), "fastforward"); 
          await music.seekRelative(message.guild.id, seconds); 
          await replyAndAutoDelete(message, `Jumped forward ${formatDuration(seconds)}.`); 
          return; 
        } 
        case "rewind": { 
          await music.assertCanControl(await message.guild.members.fetch(message.author.id), message.guild.id); 
          const seconds = readSeekDurationInput(rest.join(" "), "rewind"); 
          await music.seekRelative(message.guild.id, -seconds); 
          await replyAndAutoDelete(message, `Jumped backward ${formatDuration(seconds)}.`); 
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
          if (subcommand === "self") {
            const selfSubcommand = rest[1]?.toLowerCase() ?? "show";
            if (selfSubcommand === "show") {
              const settings = music.getPremiumUser(message.author.id);
              await replyAndAutoDelete(
                message,
                settings?.personalPrefix ? `Your personal prefix is \`${settings.personalPrefix}\`.` : "You do not have a personal prefix set."
              );
              return;
            }

            if (selfSubcommand === "set") {
              const personalPrefix = rest.slice(2).join(" ").trim();
              if (!personalPrefix) {
                throw new Error("Use `prefix self set <value>`.");
              }

              const settings = await music.setPersonalPrefix(message.author.id, personalPrefix);
              await replyAndAutoDelete(message, `Personal prefix set to \`${settings.personalPrefix}\`.`);
              return;
            }

            if (selfSubcommand === "remove") {
              await music.setPersonalPrefix(message.author.id, undefined);
              await replyAndAutoDelete(message, "Personal prefix cleared.");
              return;
            }

            throw new Error("Use `prefix self <set|remove|show>`.");
          }

          if (subcommand === "show" || subcommand === "list") { 
            await replyAndAutoDelete(message, `Current prefixes: ${formatPrefixList(music.getPrefixes(message.guild.id))}`); 
            return; 
          }

          await ensureModeratorGuildMember(await message.guild.members.fetch(message.author.id), music);
          const newPrefix = rest.slice(1).join(" ").trim();
          if (!newPrefix) {
            throw new Error("Use `prefix set <value>`, `prefix add <value>`, or `prefix remove <value>`.");
          }

          if (subcommand === "set") {
            const settings = await music.setPrefixes(message.guild.id, [newPrefix]);
            await replyAndAutoDelete(message, `Prefixes replaced. Current prefixes: ${formatPrefixList(settings.prefixes)}`);
            return;
          }

          if (subcommand === "add") {
            const settings = await music.addPrefix(message.guild.id, newPrefix);
            await replyAndAutoDelete(message, `Prefix added. Current prefixes: ${formatPrefixList(settings.prefixes)}`);
            return;
          }

          if (subcommand === "remove") {
            const settings = await music.removePrefix(message.guild.id, newPrefix);
            await replyAndAutoDelete(message, `Prefix removed. Current prefixes: ${formatPrefixList(settings.prefixes)}`);
            return;
          }

          throw new Error("Use `prefix show`, `prefix set <value>`, `prefix add <value>`, or `prefix remove <value>`.");
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
        case "subscribe": {
          const checkoutUrl = await music.createPremiumCheckoutUrl(message.author.id);
          await replyAndAutoDelete(message, `Premium is **$4.99/month**. Complete checkout here: ${checkoutUrl}`);
          return;
        }
        case "247": {
          const enabled = parseToggleValue(rest[0]);
          if (enabled === undefined) {
            throw new Error("Use `247 <on|off>`.");
          }

          const member = await message.guild.members.fetch(message.author.id);
          const isEnabled = await music.setStayInVoiceForPremium(member, message.channelId, enabled);
          await replyAndAutoDelete(message, `24/7 voice is now ${isEnabled ? "on" : "off"}.`);
          return;
        }
        case "solo": {
          const enabled = parseToggleValue(rest[0]);
          if (enabled === undefined) {
            throw new Error("Use `solo <on|off>`.");
          }

          const member = await message.guild.members.fetch(message.author.id);
          const soloSessionUserId = await music.setSoloSessionForPremium(member, message.channelId, enabled);
          await replyAndAutoDelete(message, soloSessionUserId ? "Solo session is now on for you." : "Solo session is now off.");
          return;
        }
        case "premium": 
          await handlePrefixPremiumCommand(message, music, rest); 
          return; 
        case "owner": { 
          if (!music.hasBotManagementAccess(message.author.id)) { 
            throw new Error("Only configured bot owners or bot managers can use that command."); 
          }  

          const subcommand = rest[0]?.toLowerCase() ?? "status"; 
          if (subcommand === "shocklists") {   
            await replyWithoutAutoDelete(message, formatAllPlaylists(music.listAllPlaylists()));   
            return;   
          }  
 
          if (subcommand === "removeaccess") { 
            const targetId = readMentionOrId(rest[1], "Use `owner removeaccess <user id|mention>`."); 
            await music.denyBotAccessGlobally(targetId); 
            await replyAndAutoDelete(message, `<@${targetId}> can no longer use this bot in any server.`); 
            return; 
          } 

          if (subcommand === "premiumlist") {
            await replyWithoutAutoDelete(message, formatPremiumUsers(music));
            return;
          }
 
          if (subcommand === "shocklistview") {  
            const ownerId = readMentionOrId(rest[1], "Use `owner shocklistview <owner id|mention> <name>`."); 
            const playlistName = rest.slice(2).join(" ").trim(); 
            if (!playlistName) { 
              throw new Error("Use `owner shocklistview <owner id|mention> <name>`."); 
            } 
            const playlist = music.getPlaylist(ownerId, playlistName);  
            if (!playlist) { 
              throw new Error("That shock-list does not exist."); 
            } 
            await replyWithoutAutoDelete(message, formatPlaylistTracks(playlist, true)); 
            return; 
          } 

          if (subcommand === "shocklistload") { 
            const ownerId = readMentionOrId(rest[1], "Use `owner shocklistload <owner id|mention> <name>`."); 
            const playlistName = rest.slice(2).join(" ").trim(); 
            if (!playlistName) { 
              throw new Error("Use `owner shocklistload <owner id|mention> <name>`."); 
            } 
            const count = await music.loadPlaylistFromMessage(message, playlistName, ownerId); 
            await replyAndAutoDelete(message, `Loaded ${count} track${count === 1 ? "" : "s"} from <@${ownerId}>'s shock-list.`); 
            return; 
          } 

          throw new Error("Use `owner removeaccess <user>`, `owner premiumlist`, `owner shocklists`, `owner shocklistview <owner> <name>`, or `owner shocklistload <owner> <name>`.");   
        }   
        case "clean": {
          await ensureModeratorGuildMember(await message.guild.members.fetch(message.author.id), music);

          const cleaned = await cleanBotMessages(message, music, Number.parseInt(rest[0] ?? "", 10) || 50);
          await replyAndAutoDelete(message, `Deleted ${cleaned} message${cleaned === 1 ? "" : "s"}.`);
          return;
        }
      }
    } catch (error) {
      console.error(`[prefix:${command ?? "unknown"}]`, error);
      await reportPrefixError(message, command, error instanceof Error ? error.message : "Something went wrong.");
    }
  });

  await loginWithRetry(client);
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
      await interaction.deferReply(privateReplyOptions(interaction.guildId));
      const voiceChannel = await music.join(interaction);
      await editInteractionReply(interaction, `Joined **${voiceChannel.name}**.`, "Voice Connected");
      return;
    }

    case "play": {
      await interaction.deferReply(privateReplyOptions(interaction.guildId));
      const input = interaction.options.getString("song", true).trim();

      const result = await music.play(interaction, input);
      const [track] = result.tracks;
      if (!track) {
        throw new Error("No tracks were queued.");
      }

      await editInteractionReply( 
        interaction, 
        result.tracks.length > 1 
          ? `Queued **${result.tracks.length}**${result.playlistTotalTracks && result.playlistTotalTracks > result.tracks.length ? ` of **${result.playlistTotalTracks}**` : ""} tracks${result.playlistName ? ` from **${result.playlistName}**` : ""}.` 
          : buildQueuedTrackPayload(track),  
        result.tracks.length > 1 ? "Queued Playlist" : "Queued Track" 
      ); 
      return;
    }

    case "play-file": {
      await interaction.deferReply(privateReplyOptions(interaction.guildId));
      const file = interaction.options.getAttachment("file", true);

      if (!isPlayableAttachment(file)) {
        throw new Error("Upload a playable audio or video file like mp3, wav, m4a, flac, ogg, webm, or mp4.");
      }

      const result = await music.play(interaction, file.url);
      const [track] = result.tracks;
      if (!track) {
        throw new Error("No tracks were queued.");
      }

      await editInteractionReply( 
        interaction, 
        buildQueuedTrackPayload(track),  
        "Queued File" 
      ); 
      return;
    }

    case "insert": {
      await interaction.deferReply(privateReplyOptions(interaction.guildId));
      const insertType = interaction.options.getSubcommand();
      const query = insertType === "query" ? interaction.options.getString("query", true).trim() : undefined;
      const file = insertType === "file" ? interaction.options.getAttachment("file", true) : undefined;

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
        buildQueuedTrackPayload(track),  
        "Inserted Track" 
      ); 
      return;
    }

    case "search": {
      await interaction.deferReply();
      const query = interaction.options.getString("query", true);
      const results = await music.search(query);
      if (!results.length || !guildId) {
        await editInteractionReply(interaction, formatSearchResults(query, results), "Search Results");
        return;
      }

      const session = createSearchSession(guildId, interaction.channelId, interaction.user.id, query, results);
      await editInteractionReply(interaction, buildSearchSelectPayload(session));
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
      await replyToInteraction(interaction, "Stopped playback and cleared the queue.", "Playback Updated");
      return;

    case "disconnect":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      await music.disconnect(guildId);
      await replyToInteraction(interaction, "Disconnected from voice.", "Voice Disconnected");
      return;

    case "clear":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      await music.clearQueue(guildId);
      await replyToInteraction(interaction, "Queue cleared.", "Queue Updated");
      return;

    case "queue":
      if (!guildId) throw new Error("This command must be used in a server.");
      await replyToInteraction(interaction, buildQueueInteractionPayload(music.getSnapshot(guildId), interaction.user.id, 0, true));
      return;

    case "history":
      if (!guildId) throw new Error("This command must be used in a server.");
      await replyToInteraction(
        interaction,
        buildHistoryPayload(
          music.getSongHistory(guildId, historyLookbackDays),
          guildId,
          interaction.user.id,
          0,
          true
        )
      );
      return;

    case "help":
      await replyToInteraction(
        interaction,
        { content: formatBotHelp(guildId ? music.getPrefixes(guildId) : [";"]), ephemeral: true },
        "Help"
      );
      return;

    case "commands":
      await replyToInteraction(
        interaction,
        { content: formatCommandCheatSheet(guildId ? music.getPrefixes(guildId) : [";"]), ephemeral: true },
        "Command Cheat Sheet"
      );
      return;

    case "fix": {
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      await interaction.deferReply(privateReplyOptions(interaction.guildId));
      const result = await music.autoFix(guildId);
      await editInteractionReply(interaction, formatAutoFixResult(result), "Auto Fix");
      return;
    }

    case "restart":
      if (!guildId) throw new Error("This command must be used in a server.");
      {
        await ensureControlAccess(interaction, music);
        const track = await music.restartCurrent(guildId);
        await replyToInteraction(interaction, `Restarted **${track.title}**.`, "Playback Updated");
      }
      return;

    case "reboot":  
      await ensureBotOwnerAccess(interaction, music);  
      await interaction.deferReply(privateReplyOptions(interaction.guildId));  
      await editInteractionReply(interaction, "Reboot requested. Preparing to restart the bot process.", "Rebooting"); 
      await editInteractionReply(interaction, "Bot restart scheduled. The process will exit in 1 second and the local launcher will bring it back.", "Rebooting"); 
      scheduleBotRestart();  
      return;  
 
    case "lavaboot": {  
      await ensureBotOwnerAccess(interaction, music);  
      await interaction.deferReply(privateReplyOptions(interaction.guildId));  
      await editInteractionReply(interaction, "Lavalink restart requested. Looking for the local Lavalink process now.", "LavaBoot"); 
      try { 
        const output = await restartLocalLavalink();  
        await editInteractionReply(interaction, `Lavalink restart completed.\n${output}`, "LavaBoot");  
      } catch (error) { 
        await editInteractionReply(interaction, `Lavalink restart failed.\n${formatErrorMessage(error)}`, "LavaBoot"); 
      } 
      return;  
    }  
 
    case "synccommands": 
      await ensureBotOwnerAccess(interaction, music); 
      await interaction.deferReply(privateReplyOptions(interaction.guildId)); 
      await registerCommands(); 
      await editInteractionReply( 
        interaction, 
        `Slash commands re-registered using ${appConfig.discordGuildId ? "guild" : "global"} scope.`, 
        "Owner Command" 
      ); 
      return; 
 
    case "removeafterplayed": {  
      if (!guildId) throw new Error("This command must be used in a server."); 
      await ensureControlAccess(interaction, music);
      const enabled = interaction.options.getSubcommand() === "on";
      const removeAfterPlayed = await music.toggleRemoveAfterPlayed(
        guildId,
        enabled
      );
      await replyToInteraction(
        interaction,
        `Already-played songs are now ${removeAfterPlayed ? "hidden from" : "shown in"} the queue view.`,
        "Queue Updated"
      );
      return;
    }

    case "sessionsettings":
      if (!guildId) throw new Error("This command must be used in a server.");
      await replyToInteraction(interaction, { ...embedTextPayload(formatSessionSettings(music.getSnapshot(guildId)), { title: "Session Settings" }), ephemeral: true });
      return;

    case "nowplaying":
      if (!guildId) throw new Error("This command must be used in a server.");
      const snapshot = music.getSnapshot(guildId);
      await replyToInteraction(
        interaction,
        snapshot.current
          ? formatNowPlayingTrack(snapshot.current)
          : "Nothing is playing right now.",
        "Now Playing"
      );
      return;

    case "volume":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureModeratorAccess(interaction, music);
      await music.setVolume(guildId, interaction.options.getInteger("percent", true));
      await replyToInteraction(interaction, `Volume set to ${interaction.options.getInteger("percent", true)}%.`, "Playback Updated");
      return;

    case "filter": 
      if (!guildId) throw new Error("This command must be used in a server."); 
      await ensureControlAccess(interaction, music); 
      music.assertPremiumOrBotManagementUser(interaction.user.id); 
      const preset = interaction.options.getString("preset", true) as FilterPreset;
      await music.setFilterPreset(guildId, preset);
      await replyToInteraction(interaction, `Filter set to **${preset}**.`, "Playback Updated");
      if (preset === "karaoke") {
        await maybeSendKaraokeLyricsToInteraction(interaction, music, lyrics);
      } 
      return; 

    case "subscribe": {
      const checkoutUrl = await music.createPremiumCheckoutUrl(interaction.user.id);
      await replyToInteraction(
        interaction,
        {
          content: `Premium is **$4.99/month**. Complete checkout here: ${checkoutUrl}`,
          ephemeral: true
        },
        "Premium"
      );
      return;
    }

    case "247": {
      if (!guildId || !interaction.guild) throw new Error("This command must be used in a server.");
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const enabled = interaction.options.getString("mode", true) === "on";
      const isEnabled = await music.setStayInVoiceForPremium(member, interaction.channelId, enabled);
      await replyToInteraction(interaction, `24/7 voice is now ${isEnabled ? "on" : "off"}.`, "Premium");
      return;
    }

    case "solo": {
      if (!guildId || !interaction.guild) throw new Error("This command must be used in a server.");
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const enabled = interaction.options.getString("mode", true) === "on";
      const soloSessionUserId = await music.setSoloSessionForPremium(member, interaction.channelId, enabled);
      await replyToInteraction(
        interaction,
        soloSessionUserId ? "Solo session is now on for you." : "Solo session is now off.",
        "Premium"
      );
      return;
    }

    case "skip": 
      if (!guildId) throw new Error("This command must be used in a server."); 
      const skipTo = interaction.options.getInteger("to", false);
      if (skipTo) { 
        await ensureControlAccess(interaction, music); 
        const queuePosition = resolveUpcomingQueuePosition(music.getSnapshot(guildId), skipTo); 
        await music.skipTo(guildId, queuePosition); 
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
      const displayPosition = interaction.options.getInteger("index", true); 
      const queuePosition = resolveUpcomingQueuePosition(music.getSnapshot(guildId), displayPosition); 
      const removed = await music.remove(guildId, queuePosition); 
      await replyToInteraction(interaction, `Removed **${removed.title}**.`, "Queue Updated"); 
      return; 

    case "move":  
      if (!guildId) throw new Error("This command must be used in a server.");  
      await ensureControlAccess(interaction, music);  
      const from = interaction.options.getInteger("from", true);  
      const to = interaction.options.getInteger("to", true);  
      const queueSnapshot = music.getSnapshot(guildId);  
      const fromQueuePosition = resolveUpcomingQueuePosition(queueSnapshot, from, "source position");  
      const toQueuePosition = resolveUpcomingQueuePosition(queueSnapshot, to, "target position");  
      const moved = await music.move(guildId, fromQueuePosition, toQueuePosition); 
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
      const start = interaction.options.getInteger("start", true); 
      const removedCount = await music.massRemove( 
        guildId, 
        resolveUpcomingQueuePosition(music.getSnapshot(guildId), start, "start position"), 
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
      {
        const seconds = readSeekDurationInput(interaction.options.getString("duration", true), "fastforward"); 
        await music.seekRelative(guildId, seconds); 
        await replyToInteraction(interaction, `Jumped forward ${formatDuration(seconds)}.`, "Playback Updated"); 
      }
      return; 

    case "rewind": 
      if (!guildId) throw new Error("This command must be used in a server."); 
      await ensureControlAccess(interaction, music); 
      {
        const seconds = readSeekDurationInput(interaction.options.getString("duration", true), "rewind"); 
        await music.seekRelative(guildId, -seconds); 
        await replyToInteraction(interaction, `Jumped backward ${formatDuration(seconds)}.`, "Playback Updated"); 
      }
      return; 

    case "autoplay":
      if (!guildId) throw new Error("This command must be used in a server.");
      await ensureControlAccess(interaction, music);
      const autoplay = await music.updateGuildSettings(guildId, {
        autoplay: interaction.options.getSubcommand() === "on"
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
      const prefixGroup = interaction.options.getSubcommandGroup(false);
      if (prefixGroup === "self") {
        if (prefixSubcommand === "show") {
          const settings = music.getPremiumUser(interaction.user.id);
          await replyToInteraction(
            interaction,
            settings?.personalPrefix ? `Your personal prefix is \`${settings.personalPrefix}\`.` : "You do not have a personal prefix set.",
            "Prefix"
          );
          return;
        }

        if (prefixSubcommand === "set") {
          const settings = await music.setPersonalPrefix(interaction.user.id, interaction.options.getString("value", true));
          await replyToInteraction(interaction, `Personal prefix set to \`${settings.personalPrefix}\`.`, "Prefix");
          return;
        }

        if (prefixSubcommand === "remove") {
          await music.setPersonalPrefix(interaction.user.id, undefined);
          await replyToInteraction(interaction, "Personal prefix cleared.", "Prefix");
          return;
        }

        throw new Error("Unknown personal prefix subcommand.");
      }

      if (prefixSubcommand === "show") { 
        await replyToInteraction(interaction, `Current prefixes: ${formatPrefixList(music.getPrefixes(guildId))}`, "Prefix"); 
        return; 
      }
      await ensureModeratorAccess(interaction, music);
      const newPrefix = interaction.options.getString("value", true);

      if (prefixSubcommand === "set") {
        const settings = await music.setPrefixes(guildId, [newPrefix]);
        await replyToInteraction(interaction, `Prefixes replaced. Current prefixes: ${formatPrefixList(settings.prefixes)}`, "Prefix");
        return;
      }

      if (prefixSubcommand === "add") {
        const settings = await music.addPrefix(guildId, newPrefix);
        await replyToInteraction(interaction, `Prefix added. Current prefixes: ${formatPrefixList(settings.prefixes)}`, "Prefix");
        return;
      }

      if (prefixSubcommand === "remove") {
        const settings = await music.removePrefix(guildId, newPrefix);
        await replyToInteraction(interaction, `Prefix removed. Current prefixes: ${formatPrefixList(settings.prefixes)}`, "Prefix");
        return;
      }

      throw new Error("Unknown prefix subcommand.");

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
      await interaction.deferReply(privateReplyOptions(interaction.guildId)); 
 
      const subcommand = interaction.options.getSubcommand();  
      if (subcommand === "shocklists") {    
        await editInteractionReply(interaction, formatAllPlaylists(music.listAllPlaylists()), "Saved Shock-lists");    
        return;   
      }   
 
      if (subcommand === "removeaccess") { 
        const target = interaction.options.getUser("user", true); 
        await music.denyBotAccessGlobally(target.id); 
        await editInteractionReply(interaction, `**${target.username}** can no longer use this bot in any server.`, "Owner Command"); 
        return; 
      } 

      if (subcommand === "premiumlist") {
        await editInteractionReply(interaction, formatPremiumUsers(music), "Premium Users");
        return;
      }
 
      if (subcommand === "shocklistview") {   
        const owner = interaction.options.getUser("owner", true);  
        const playlist = music.getPlaylist(owner.id, interaction.options.getString("name", true));  
        if (!playlist) { 
          throw new Error("That shock-list does not exist."); 
        } 
        await editInteractionReply(interaction, formatPlaylistTracks(playlist, true), "Shock-list Songs"); 
        return; 
      } 

      if (subcommand === "shocklistload") { 
        if (!guildId) throw new Error("This command must be used in a server."); 
        const owner = interaction.options.getUser("owner", true); 
        const count = await music.loadPlaylist(interaction, interaction.options.getString("name", true), owner.id); 
        await editInteractionReply(interaction, `Loaded ${count} track${count === 1 ? "" : "s"} from **${owner.username}**'s shock-list.`, "Shock-list Updated"); 
        return; 
      } 

      throw new Error("Unknown owner subcommand."); 
    } 

    case "shock-list":
      if (!guildId) throw new Error("This command must be used in a server.");
      await handlePlaylistCommand(interaction, music);
      return;

    case "clean": {
      await ensureModeratorAccess(interaction, music);

      await interaction.deferReply(privateReplyOptions(interaction.guildId));
      const cleaned = await cleanBotMessages(interaction, music, interaction.options.getInteger("amount", false) ?? 50);
      await editInteractionReply(interaction, `Deleted ${cleaned} message${cleaned === 1 ? "" : "s"}.`, "Cleaned Messages");
      return;
    }
  }
}

async function handleQueuePageButton(interaction: ButtonInteraction, music: MusicManager) {
  const [, guildId, userId, rawPage] = interaction.customId.split(":");
  if (!guildId || !userId || userId !== interaction.user.id) {
    await interaction.reply(
      applyPrivateResponsePreference({
        ...embedTextPayload("Use `/queue` to open your own queue view.", { title: "Queue" }),
        ephemeral: true
      }, interaction.guildId)
    );
    return;
  }

  const page = Number.parseInt(rawPage ?? "0", 10);
  await interaction.update(
    buildQueueInteractionPayload(
      music.getSnapshot(guildId),
      interaction.user.id,
      Number.isInteger(page) ? page : 0
    )
  );
}

async function handleHistoryPageButton(interaction: ButtonInteraction, music: MusicManager) {
  const [, guildId, userId, rawPage] = interaction.customId.split(":");
  if (!guildId || !userId || userId !== interaction.user.id) {
    await interaction.reply(
      applyPrivateResponsePreference({
        ...embedTextPayload("Use `/history` to open your own history view.", { title: "Song History" }),
        ephemeral: true
      }, interaction.guildId)
    );
    return;
  }

  const page = Number.parseInt(rawPage ?? "0", 10);
  await interaction.update(
    buildHistoryPayload(
      music.getSongHistory(guildId, historyLookbackDays),
      guildId,
      interaction.user.id,
      Number.isInteger(page) ? page : 0
    )
  );
}

async function handlePagedResponseButton(interaction: ButtonInteraction) {
  const [, sessionId, userId, rawPage] = interaction.customId.split(":");
  const session = sessionId ? pagedResponseSessions.get(sessionId) : undefined;
  if (!session || !userId) {
    await interaction.reply(
      applyPrivateResponsePreference({
        ...embedTextPayload("That paged response expired. Run the command again.", { title: "Page" }),
        ephemeral: true
      }, interaction.guildId)
    );
    return;
  }

  if (session.userId !== interaction.user.id || userId !== interaction.user.id) {
    await interaction.reply(
      applyPrivateResponsePreference({
        ...embedTextPayload("Open your own copy of this command to page through it.", { title: "Page" }),
        ephemeral: true
      }, interaction.guildId)
    );
    return;
  }

  const page = Number.parseInt(rawPage ?? "0", 10);
  await interaction.update(
    buildPagedResponsePayload(
      session,
      Number.isInteger(page) ? page : 0
    )
  );
}

async function handleSearchSelect(interaction: StringSelectMenuInteraction, music: MusicManager) {
  const [, guildId, userId, sessionId] = interaction.customId.split(":");
  if (!guildId || !userId || userId !== interaction.user.id) {
    await interaction.reply(
      applyPrivateResponsePreference({
        ...embedTextPayload("Use `/search` to open your own search results.", { title: "Search" }),
        ephemeral: true
      }, interaction.guildId)
    );
    return;
  }

  const session = takeSearchSession(guildId, userId, sessionId);
  const selectedIndex = Number.parseInt(interaction.values[0] ?? "", 10);
  const result = Number.isInteger(selectedIndex) ? session?.results[selectedIndex] : undefined;
  if (!session || !result) {
    await interaction.reply(
      applyPrivateResponsePreference({
        ...embedTextPayload("Those search results expired. Run `/search` again.", { title: "Search" }),
        ephemeral: true
      }, interaction.guildId)
    );
    return;
  } 

  await interaction.deferUpdate(); 
  const queued = await music.playFromSearchSelection(interaction, result.url); 
  const [track] = queued.tracks;
  await interaction.editReply({ 
    ...(track && guildId ? buildQueuedTrackPayload(track) : embedTextPayload(formatQueuedSearchResult(result), { title: "Queued Track" })), 
    components: [] 
  }); 
}

async function maybeQueueSearchNumberChoice(message: Message, music: MusicManager) {
  if (!message.guild) {
    return false;
  }

  const choice = readSearchChoice(message);
  if (!choice) {
    return false;
  }

  const session = searchSessions.get(searchSessionKey(message.guild.id, message.author.id));
  if (!session || session.channelId !== message.channelId) {
    return false;
  }

  const result = session.results[choice - 1];
  if (!result) {
    return false;
  }

  searchSessions.delete(searchSessionKey(message.guild.id, message.author.id));
  scheduleMessageDeletion(message);

  try { 
    const queued = await music.playFromMessage(message, result.url); 
    const [track] = queued.tracks;
    await replyAndAutoDelete(
      message,
      track ? buildQueuedTrackPayload(track) : formatQueuedSearchResult(result)
    ); 
  } catch (error) { 
    await reportPrefixError(message, "search", error instanceof Error ? error.message : "Something went wrong.");
  }

  return true;
}

async function handlePrefixPremiumCommand(message: Message, music: MusicManager, args: string[]) { 
  if (!message.guild) {
    throw new Error("This command must be used in a server.");
  }

  const subcommand = args[0]?.toLowerCase(); 
  if (subcommand === "subscribe") {
    const checkoutUrl = await music.createPremiumCheckoutUrl(message.author.id);
    await replyAndAutoDelete(message, `Premium is **$4.99/month**. Complete checkout here: ${checkoutUrl}`);
    return;
  }

  const member = await message.guild.members.fetch(message.author.id); 

  if (subcommand === "prefix") {
    const value = args.slice(1).join(" ").trim();
    const shouldClear = !value || ["clear", "none", "off"].includes(value.toLowerCase());
    const settings = await music.setPersonalPrefix(message.author.id, shouldClear ? undefined : value);
    await replyAndAutoDelete(
      message,
      settings.personalPrefix ? `Personal prefix set to \`${settings.personalPrefix}\`.` : "Personal prefix cleared."
    );
    return;
  }

  if (subcommand === "vc247" || subcommand === "24/7" || subcommand === "247") {
    const enabled = parseToggleValue(args[1]);
    if (enabled === undefined) {
      throw new Error("Use `premium vc247 <on|off>`.");
    }

    const isEnabled = await music.setStayInVoiceForPremium(member, message.channelId, enabled);
    await replyAndAutoDelete(message, `24/7 voice is now ${isEnabled ? "on" : "off"}.`);
    return;
  }

  if (subcommand === "solo") {
    const enabled = parseToggleValue(args[1]);
    if (enabled === undefined) {
      throw new Error("Use `premium solo <on|off>`.");
    }

    const soloSessionUserId = await music.setSoloSessionForPremium(member, message.channelId, enabled);
    await replyAndAutoDelete(message, soloSessionUserId ? "Solo session is now on for you." : "Solo session is now off.");
    return;
  }

  throw new Error("Use `premium subscribe`, `premium prefix [value|clear]`, `premium vc247 <on|off>`, or `premium solo <on|off>`."); 
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

    case "privateresponses": {
      const makePublic = parseToggleValue(args[1]);
      if (makePublic === undefined) {
        throw new Error("Use `moderation privateresponses <on|off>`.");
      }

      await music.updateGuildSettings(guildId, { privateResponsesPublic: makePublic });
      await replyAndAutoDelete(
        message,
        `Normally-private bot responses will now be sent ${makePublic ? "publicly" : "privately"}.`
      );
      return;
    }

    case "autodelete": {
      const enabled = parseToggleValue(args[1]);
      if (enabled === undefined) {
        throw new Error("Use `moderation autodelete <on|off>`.");
      }

      await music.updateGuildSettings(guildId, { autoDeleteBotResponses: enabled });
      await replyAndAutoDelete(message, `Auto-delete for bot responses is now ${enabled ? "enabled" : "disabled"}.`);
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
    case "addlink": {  
      const parsed = splitNameAndTrailingLink(name, "Use `shock-list addlink <name> <song link>`.");  
      const result = await music.addTrackLinkToPlaylist(guildId, message.author.id, message.author.username, parsed.name, parsed.link);  
      await replyAndAutoDelete(message, `Added 1 song to **${result.playlist.name}**. It now has ${result.playlist.tracks.length} tracks.`);  
      return;  
    } 
    case "addplaylist": {  
      const parsed = splitNameAndTrailingLink(name, "Use `shock-list addplaylist <name> <playlist link>`.");  
      const result = await music.addPlaylistLinkToPlaylist(guildId, message.author.id, message.author.username, parsed.name, parsed.link);  
      await replyAndAutoDelete(message, `Added ${result.addedCount} track${result.addedCount === 1 ? "" : "s"} to **${result.playlist.name}**. It now has ${result.playlist.tracks.length} tracks.`);  
      return;  
    } 
    case "view": { 
      if (!name) { 
        throw new Error("Use `shock-list view <name>`."); 
      } 
      const playlist = music.getPlaylist(message.author.id, name);  
      if (!playlist) { 
        throw new Error("That shock-list does not exist."); 
      } 
      await replyWithoutAutoDelete(message, formatPlaylistTracks(playlist)); 
      return; 
    } 
    case "remove": { 
      const song = Number.parseInt(args[1] ?? "", 10); 
      const playlistName = args.slice(2).join(" ").trim(); 
      if (!Number.isInteger(song) || !playlistName) {  
        throw new Error("Use `shock-list remove <song number> <name>`.");  
      }  
      const removed = await music.removeTrackFromPlaylist(guildId, message.author.id, playlistName, song);  
      await replyAndAutoDelete(message, `Removed **${removed.title}** from **${playlistName}**.`);  
      return;  
    } 
    case "list": { 
      const playlists = music.listPlaylists(message.author.id);  
      await replyAndAutoDelete(
        message,
        playlists.length
          ? playlists.map((playlist) => `• ${playlist.name} (${playlist.tracks.length})`).join("\n")
          : "You do not have any saved shock-lists yet." 
      );
      return;
    }
    case "delete": {
      if (!name) { 
        throw new Error("Use `shock-list delete <name>`."); 
      } 
      await music.deletePlaylist(message.author.id, name);  
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

    case "privateresponses": {
      const makePublic = interaction.options.getBoolean("public", true);
      await music.updateGuildSettings(guildId, { privateResponsesPublic: makePublic });
      await replyToInteraction(
        interaction,
        `Normally-private bot responses will now be sent ${makePublic ? "publicly" : "privately"}.`,
        "Moderation Updated"
      );
      return;
    }

    case "autodelete": {
      const enabled = interaction.options.getBoolean("enabled", true);
      await music.updateGuildSettings(guildId, { autoDeleteBotResponses: enabled });
      await replyToInteraction(
        interaction,
        `Auto-delete for bot responses is now ${enabled ? "enabled" : "disabled"}.`,
        "Moderation Updated"
      );
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
    case "addlink": {  
      const result = await music.addTrackLinkToPlaylist(  
        guildId,  
        interaction.user.id,  
        interaction.user.username, 
        interaction.options.getString("name", true), 
        interaction.options.getString("link", true) 
      ); 
      await replyToInteraction(interaction, `Added 1 song to **${result.playlist.name}**. It now has ${result.playlist.tracks.length} tracks.`, "Shock-list Updated"); 
      return; 
    }  
    case "addplaylist": {  
      const result = await music.addPlaylistLinkToPlaylist(  
        guildId,  
        interaction.user.id,  
        interaction.user.username, 
        interaction.options.getString("name", true), 
        interaction.options.getString("link", true) 
      ); 
      await replyToInteraction(interaction, `Added ${result.addedCount} track${result.addedCount === 1 ? "" : "s"} to **${result.playlist.name}**. It now has ${result.playlist.tracks.length} tracks.`, "Shock-list Updated"); 
      return; 
    } 
    case "view": { 
      const playlist = music.getPlaylist(interaction.user.id, interaction.options.getString("name", true));  
      if (!playlist) { 
        throw new Error("That shock-list does not exist."); 
      } 
      await replyToInteraction(interaction, formatPlaylistTracks(playlist), "Shock-list Songs"); 
      return; 
    }  
    case "remove": {  
      const removed = await music.removeTrackFromPlaylist(  
        guildId,  
        interaction.user.id,  
        interaction.options.getString("name", true), 
        interaction.options.getInteger("song", true) 
      ); 
      await replyToInteraction(interaction, `Removed **${removed.title}**.`, "Shock-list Updated"); 
      return; 
    } 
    case "list": { 
      const playlists = music.listPlaylists(interaction.user.id);  
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
      await music.deletePlaylist(interaction.user.id, interaction.options.getString("name", true));  
      await replyToInteraction(interaction, "Shock-list deleted.", "Shock-list Updated"); 
      return; 
  }
}
