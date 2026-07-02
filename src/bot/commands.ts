import { ChannelType, REST, Routes, SlashCommandBuilder } from "discord.js";
import { appConfig } from "../config.js";

export const registeredCommandNames = [
  "play",
  "play-file",
  "insert",
  "join",
  "pause",
  "resume",
  "stop",
  "disconnect",
  "clear",
  "queue",
  "history",
  "help",
  "dj",
  "commands",
  "fix",
  "restart",
  "reboot",
  "lavaboot",
  "synccommands",
  "removeafterplayed",
  "sessionsettings",
  "nowplaying",
  "search",
  "lyrics",
  "save",
  "volume",
  "skip",
  "remove",
  "move",
  "removelast",
  "removeduplicates",
  "removeabsent",
  "massremove",
  "shuffle",
  "previous",
  "fastforward",
  "rewind",
  "autoplay",
  "voteskip",
  "filter",
  "prefix",
  "permissions",
  "shock-list",
  "clean",
  "purge",
  "moderation",
  "subscribe",
  "solo",
  "247",
  "clearcache",
  "owner"
] as const;

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Queue a track from a URL or search query.")
    .addStringOption((option) =>
      option.setName("song").setDescription("A song URL or search terms").setRequired(true).setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName("play-file")
    .setDescription("Queue an uploaded audio or video file.")
    .addAttachmentOption((option) =>
      option.setName("file").setDescription("An uploaded audio or video file").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("insert")
    .setDescription("Insert a track into the next spot in the queue.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("query")
        .setDescription("Insert a track from a URL or search query.")
        .addStringOption((option) =>
          option.setName("query").setDescription("A song URL or search terms").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("file")
        .setDescription("Insert an uploaded audio or video file.")
        .addAttachmentOption((option) =>
          option.setName("file").setDescription("An uploaded audio or video file").setRequired(true)
        )
    ),
  new SlashCommandBuilder().setName("join").setDescription("Join your current voice channel."),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback."),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback."),
  new SlashCommandBuilder().setName("stop").setDescription("Stop playback and clear the queue."),
  new SlashCommandBuilder().setName("disconnect").setDescription("Disconnect from the voice channel."),
  new SlashCommandBuilder().setName("clear").setDescription("Clear the queue."),
  new SlashCommandBuilder().setName("queue").setDescription("Show played, current, and upcoming songs."),
  new SlashCommandBuilder().setName("history").setDescription("Show songs played in this guild during the past 14 days."),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Get help using the bot.")
    .addStringOption((option) =>
      option.setName("question").setDescription("Ask how to do something with the bot").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("dj")
    .setDescription("Ask the bot to reason about playback, queue cleanup, or song picks.")
    .addStringOption((option) =>
      option.setName("request").setDescription("Example: clean up the queue, play chill songs, why is playback stuck").setRequired(true)
    ),
  new SlashCommandBuilder().setName("commands").setDescription("Show a command cheat sheet."),
  new SlashCommandBuilder().setName("fix").setDescription("Run automatic playback recovery checks if the bot seems glitchy."),
  new SlashCommandBuilder().setName("restart").setDescription("Restart the currently playing song."),
  new SlashCommandBuilder().setName("reboot").setDescription("Bot managers: reboot the bot process."),
  new SlashCommandBuilder().setName("lavaboot").setDescription("Bot managers: restart the local Lavalink process."),
  new SlashCommandBuilder().setName("synccommands").setDescription("Bot managers: re-register the bot's slash commands."),
  new SlashCommandBuilder().setName("clearcache").setDescription("Bot managers: clear runtime music session cache."),
  new SlashCommandBuilder()
    .setName("removeafterplayed")
    .setDescription("Toggle whether already-played songs are hidden from the queue view.")
    .addSubcommand((subcommand) =>
      subcommand.setName("on").setDescription("Hide already-played songs in queue.")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("off").setDescription("Show already-played songs in queue.")
    ),
  new SlashCommandBuilder().setName("sessionsettings").setDescription("Show playback and server session settings."),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Show the current track."),
  new SlashCommandBuilder()
    .setName("search")
    .setDescription("Search for songs without queuing them.")
    .addStringOption((option) =>
      option.setName("query").setDescription("Song title, artist, or keywords").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("lyrics")
    .setDescription("Show lyrics for the current song or a specific query.")
    .addStringOption((option) =>
      option.setName("query").setDescription("Song title or artist and title").setRequired(false)
    ),
  new SlashCommandBuilder().setName("save").setDescription("DM yourself the current song."),
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Moderators: set the playback volume.")
    .addIntegerOption((option) =>
      option.setName("percent").setDescription("Volume from 1 to 150").setRequired(true).setMinValue(1).setMaxValue(150)
    ),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current track or vote skip.")
    .addIntegerOption((option) =>
      option.setName("to").setDescription("Skip to this /queue display position").setRequired(false).setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a track from the queue.")
    .addIntegerOption((option) =>
      option.setName("index").setDescription("/queue display position to remove").setRequired(true).setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName("move")
    .setDescription("Move a track to a different position in the queue.")
    .addIntegerOption((option) =>
      option.setName("from").setDescription("Current /queue display position").setRequired(true).setMinValue(1)
    )
    .addIntegerOption((option) =>
      option.setName("to").setDescription("New /queue display position").setRequired(true).setMinValue(1)
    ),
  new SlashCommandBuilder().setName("removelast").setDescription("Remove the last track in the queue."),
  new SlashCommandBuilder().setName("removeduplicates").setDescription("Remove duplicate tracks from the queue."),
  new SlashCommandBuilder().setName("removeabsent").setDescription("Remove queued tracks from users no longer in voice."),
  new SlashCommandBuilder()
    .setName("massremove")
    .setDescription("Remove multiple tracks from the queue.")
    .addStringOption((option) =>
      option.setName("songs")
        .setDescription("Queue numbers separated by commas or ranges with dashes (e.g. 9, 17, 24 or 4-8)")
        .setRequired(true)
    ),
  new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle the upcoming queue."),
  new SlashCommandBuilder().setName("previous").setDescription("Play the previous track again."),
  new SlashCommandBuilder()
    .setName("fastforward")
    .setDescription("Jump forward in the current track.")
    .addStringOption((option) =>
      option.setName("duration").setDescription("How far to jump, like 30s, 1m, or 1m30s").setRequired(true).setMaxLength(16)
    ),
  new SlashCommandBuilder()
    .setName("rewind")
    .setDescription("Jump backward in the current track.")
    .addStringOption((option) =>
      option.setName("duration").setDescription("How far to jump, like 30s, 1m, or 1m30s").setRequired(true).setMaxLength(16)
    ),
  new SlashCommandBuilder()
    .setName("autoplay")
    .setDescription("Toggle autoplay for this guild.")
    .addSubcommand((subcommand) =>
      subcommand.setName("on").setDescription("Turn autoplay on.")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("off").setDescription("Turn autoplay off.")
    ),
  new SlashCommandBuilder()
    .setName("voteskip")
    .setDescription("Moderators: toggle vote skip mode for this server.")
    .addBooleanOption((option) =>
      option.setName("enabled").setDescription("Whether vote skip should be enabled").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("filter")
    .setDescription("PREMIUM: Apply or clear a playback filter preset.")
    .addStringOption((option) =>
      option
        .setName("preset")
        .setDescription("Filter preset to apply")
        .setRequired(true)
        .addChoices(
          { name: "off", value: "off" },
          { name: "bassboost", value: "bassboost" },
          { name: "nightcore", value: "nightcore" },
          { name: "vaporwave", value: "vaporwave" },
          { name: "karaoke", value: "karaoke" },
          { name: "trebleboost", value: "trebleboost" },
          { name: "8d", value: "8d" }
        )
    ),
  new SlashCommandBuilder()
    .setName("prefix")
    .setDescription("Show or update guild text-command prefixes.")
    .addSubcommandGroup((group) =>
      group
        .setName("self")
        .setDescription("PREMIUM: Set, remove, or show your personal prefix.")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("set")
            .setDescription("PREMIUM: Set your personal prefix.")
            .addStringOption((option) =>
              option.setName("value").setDescription("Your personal prefix").setRequired(true).setMaxLength(5)
            )
        )
        .addSubcommand((subcommand) =>
          subcommand.setName("remove").setDescription("PREMIUM: Remove your personal prefix.")
        )
        .addSubcommand((subcommand) =>
          subcommand.setName("show").setDescription("PREMIUM: Show your personal prefix.")
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("show").setDescription("Show the current prefixes.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Moderators: replace all prefixes with one prefix.")
        .addStringOption((option) =>
          option.setName("value").setDescription("New prefix").setRequired(true).setMaxLength(5)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Moderators: add another text-command prefix.")
        .addStringOption((option) =>
          option.setName("value").setDescription("Prefix to add").setRequired(true).setMaxLength(5)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Moderators: remove a text-command prefix.")
        .addStringOption((option) =>
          option.setName("value").setDescription("Prefix to remove").setRequired(true).setMaxLength(5)
        )
    ),
  new SlashCommandBuilder()
    .setName("permissions")
    .setDescription("Moderators: guild music permission mode and DJ role.")
    .addSubcommand((subcommand) =>
      subcommand.setName("show").setDescription("Moderators: show current guild music permissions.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("mode")
        .setDescription("Moderators: set who can manage the player.")
        .addStringOption((option) =>
          option
            .setName("value")
            .setDescription("Permission mode")
            .setRequired(true)
            .addChoices(
              { name: "everyone", value: "everyone" },
              { name: "dj", value: "dj" },
              { name: "admins", value: "admins" }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("djrole")
        .setDescription("Moderators: set or clear the DJ role.")
        .addRoleOption((option) =>
          option.setName("role").setDescription("Role allowed to control the player").setRequired(false)
        )
    ),
  new SlashCommandBuilder()
    .setName("shock-list")
    .setDescription("Manage saved shock-lists.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("save")
        .setDescription("Save the current queue as a shock-list.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Shock-list name").setRequired(true).setMaxLength(50)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("load")
        .setDescription("Load a saved shock-list into the queue.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Shock-list name").setRequired(true).setMaxLength(50)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("addcurrent")
        .setDescription("Add the current track to a shock-list.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Shock-list name").setRequired(true).setMaxLength(50)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("addlink")
        .setDescription("Add one song link to one of your shock-lists.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Shock-list name").setRequired(true).setMaxLength(50)
        )
        .addStringOption((option) =>
          option.setName("link").setDescription("Song link").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("addplaylist")
        .setDescription("Add a playlist link to one of your shock-lists.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Shock-list name").setRequired(true).setMaxLength(50)
        )
        .addStringOption((option) =>
          option.setName("link").setDescription("Playlist link").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("view")
        .setDescription("View the songs in one of your shock-lists.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Shock-list name").setRequired(true).setMaxLength(50)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove a song from one of your shock-lists.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Shock-list name").setRequired(true).setMaxLength(50)
        )
        .addIntegerOption((option) =>
          option.setName("song").setDescription("Song number from shock-list view").setRequired(true).setMinValue(1)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("list").setDescription("List your saved shock-lists.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("delete")
        .setDescription("Delete a saved shock-list.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Shock-list name").setRequired(true).setMaxLength(50)
        )
    ),
  new SlashCommandBuilder() 
    .setName("clean") 
    .setDescription("Moderators: delete the bot's recent messages in this text or voice chat.") 
    .addIntegerOption((option) => 
      option.setName("amount").setDescription("How many recent messages to inspect").setRequired(false).setMinValue(1).setMaxValue(100) 
    ), 
  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Moderators: delete the bot's recent messages, including now playing.")
    .addIntegerOption((option) =>
      option.setName("amount").setDescription("How many recent messages to inspect").setRequired(false).setMinValue(1).setMaxValue(100)
    ),
  new SlashCommandBuilder() 
    .setName("moderation") 
    .setDescription("Moderator-only bot settings for this server.")
    .addSubcommand((subcommand) =>
      subcommand.setName("show").setDescription("Show the current moderation settings.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("channelmessages")
        .setDescription("Enable or disable bot announcement messages in a text or voice chat.")
        .addBooleanOption((option) =>
          option.setName("enabled").setDescription("Whether bot messages should be enabled").setRequired(true)
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("The text or voice chat to update")
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildVoice,
              ChannelType.GuildStageVoice,
              ChannelType.GuildAnnouncement
            )
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("channelcommands")
        .setDescription("Enable or disable bot commands in a text or voice chat.")
        .addBooleanOption((option) =>
          option.setName("enabled").setDescription("Whether bot commands should be enabled").setRequired(true)
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("The text or voice chat to update")
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildVoice,
              ChannelType.GuildStageVoice,
              ChannelType.GuildAnnouncement
            )
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("command")
        .setDescription("Enable or disable a command server-wide.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Top-level command name like play or queue").setRequired(true).setMaxLength(32)
        )
        .addBooleanOption((option) =>
          option.setName("enabled").setDescription("Whether the command should be enabled").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("privateresponses")
        .setDescription("Choose whether normally-private bot responses are private or public.")
        .addBooleanOption((option) =>
          option.setName("public").setDescription("Whether private bot responses should be sent publicly").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("autodelete")
        .setDescription("Enable or disable auto-delete for bot responses in this server.")
        .addBooleanOption((option) =>
          option.setName("enabled").setDescription("Whether bot responses should auto-delete").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("member")
        .setDescription("Allow, deny, or clear a member's bot access override.")
        .addUserOption((option) =>
          option.setName("member").setDescription("The member to update").setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("access")
            .setDescription("The override to apply")
            .setRequired(true)
            .addChoices(
              { name: "allow", value: "allow" },
              { name: "deny", value: "deny" },
              { name: "clear", value: "clear" }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("removeuser")
        .setDescription("Remove the current and queued songs added by one member.")
        .addUserOption((option) =>
          option.setName("member").setDescription("The member whose songs should be removed").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("maxsonglength")
        .setDescription("Set the maximum allowed track length in seconds. Use 0 to clear.")
        .addIntegerOption((option) =>
          option.setName("seconds").setDescription("Maximum allowed song length").setRequired(true).setMinValue(0).setMaxValue(14400)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("maxshocklistlength")
        .setDescription("Set the maximum allowed shock-list size in tracks. Use 0 to clear.")
        .addIntegerOption((option) =>
          option.setName("tracks").setDescription("Maximum tracks per shock-list").setRequired(true).setMinValue(0).setMaxValue(500)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("clearprotection")
        .setDescription("Enable or disable protection for /clear when other members have songs in queue.")
        .addBooleanOption((option) =>
          option.setName("enabled").setDescription("Whether clear protection is enabled").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("stopprotection")
        .setDescription("Enable or disable protection for /stop when other members have songs in queue.")
        .addBooleanOption((option) =>
          option.setName("enabled").setDescription("Whether stop protection is enabled").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("disconnectprotection")
        .setDescription("Enable or disable protection for /disconnect when other members are in VC.")
        .addBooleanOption((option) =>
          option.setName("enabled").setDescription("Whether disconnect protection is enabled").setRequired(true)
        )
    ),
  new SlashCommandBuilder()
    .setName("subscribe")
    .setDescription("Start or manage your $3.99/month premium subscription."),
  new SlashCommandBuilder()
    .setName("solo")
    .setDescription("PREMIUM: Toggle solo session for your current voice session.")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Solo session mode")
        .setRequired(true)
        .addChoices(
          { name: "on", value: "on" },
          { name: "off", value: "off" }
        )
    ),
  new SlashCommandBuilder()
    .setName("247")
    .setDescription("PREMIUM: Toggle 24/7 voice for the current voice channel.")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("24/7 voice mode")
        .setRequired(true)
        .addChoices(
          { name: "on", value: "on" },
          { name: "off", value: "off" }
        )
    ),
  new SlashCommandBuilder()
    .setName("owner")
    .setDescription("Bot management global commands.")
    .addSubcommand((subcommand) =>
      subcommand.setName("shocklists").setDescription("List every saved shock-list.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("removeaccess")
        .setDescription("Globally remove a user's access to use this bot.")
        .addUserOption((option) =>
          option.setName("user").setDescription("The user to block from using the bot").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("premiumlist").setDescription("List premium users.")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("aliaslist").setDescription("List custom global text-command aliases.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("aliasadd")
        .setDescription("Add a custom global text-command alias.")
        .addStringOption((option) =>
          option.setName("command").setDescription("Existing command to run").setRequired(true).setMaxLength(32)
        )
        .addStringOption((option) =>
          option.setName("alias").setDescription("Alias phrase users can type after a prefix").setRequired(true).setMaxLength(64)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("aliasremove")
        .setDescription("Remove a custom global text-command alias.")
        .addStringOption((option) =>
          option.setName("alias").setDescription("Alias phrase to remove").setRequired(true).setMaxLength(64)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("shocklistview")
        .setDescription("View any user's shock-list.")
        .addUserOption((option) =>
          option.setName("owner").setDescription("Shock-list owner").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("name").setDescription("Shock-list name").setRequired(true).setMaxLength(50)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("shocklistload")
        .setDescription("Load any user's shock-list into the queue.")
        .addUserOption((option) =>
          option.setName("owner").setDescription("Shock-list owner").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("name").setDescription("Shock-list name").setRequired(true).setMaxLength(50)
        )
    )
].map((command) => command.toJSON());

export async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(appConfig.discordToken);

  if (appConfig.discordGuildId) {
    await rest.put(
      Routes.applicationGuildCommands(appConfig.discordClientId, appConfig.discordGuildId),
      { body: commands }
    );
    return;
  }

  await rest.put(Routes.applicationCommands(appConfig.discordClientId), { body: commands });
}
