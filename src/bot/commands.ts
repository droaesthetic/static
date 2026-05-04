import { ChannelType, REST, Routes, SlashCommandBuilder } from "discord.js";
import { appConfig } from "../config.js";

export const registeredCommandNames = [
  "play",
  "insert",
  "join",
  "pause",
  "resume",
  "stop",
  "clear",
  "queue",
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
  "moderation",
  "owner"
] as const;

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Queue a track from a URL, search query, or uploaded file.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("query")
        .setDescription("Queue a song from a URL or search terms.")
        .addStringOption((option) =>
          option.setName("value").setDescription("A song URL or search terms").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("file")
        .setDescription("Queue an uploaded audio or video file.")
        .addAttachmentOption((option) =>
          option.setName("value").setDescription("An uploaded audio or video file").setRequired(true)
        )
    ),
  new SlashCommandBuilder()
    .setName("insert")
    .setDescription("Insert a track into the next spot in the queue.")
    .addStringOption((option) =>
      option.setName("query").setDescription("A song URL or search terms").setRequired(false)
    )
    .addAttachmentOption((option) =>
      option.setName("file").setDescription("An uploaded audio or video file").setRequired(false)
    ),
  new SlashCommandBuilder().setName("join").setDescription("Join your current voice channel."),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback."),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback."),
  new SlashCommandBuilder().setName("stop").setDescription("Stop playback and disconnect."),
  new SlashCommandBuilder().setName("clear").setDescription("Clear the queue."),
  new SlashCommandBuilder().setName("queue").setDescription("Show the current queue."),
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
    .setDescription("Set the playback volume.")
    .addIntegerOption((option) =>
      option.setName("percent").setDescription("Volume from 1 to 150").setRequired(true).setMinValue(1).setMaxValue(150)
    ),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current track or vote skip.")
    .addIntegerOption((option) =>
      option.setName("to").setDescription("Skip directly to this queue position").setRequired(false).setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a track from the queue.")
    .addIntegerOption((option) =>
      option.setName("index").setDescription("Queue position to remove").setRequired(true).setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName("move")
    .setDescription("Move a track to a different position in the queue.")
    .addIntegerOption((option) =>
      option.setName("from").setDescription("Current queue position").setRequired(true).setMinValue(1)
    )
    .addIntegerOption((option) =>
      option.setName("to").setDescription("New queue position").setRequired(true).setMinValue(1)
    ),
  new SlashCommandBuilder().setName("removelast").setDescription("Remove the last track in the queue."),
  new SlashCommandBuilder().setName("removeduplicates").setDescription("Remove duplicate tracks from the queue."),
  new SlashCommandBuilder().setName("removeabsent").setDescription("Remove queued tracks from users no longer in voice."),
  new SlashCommandBuilder()
    .setName("massremove")
    .setDescription("Remove a block of tracks from the queue.")
    .addIntegerOption((option) =>
      option.setName("start").setDescription("First queue position to remove").setRequired(true).setMinValue(1)
    )
    .addIntegerOption((option) =>
      option.setName("count").setDescription("How many tracks to remove").setRequired(true).setMinValue(1)
    ),
  new SlashCommandBuilder().setName("previous").setDescription("Play the previous track again."),
  new SlashCommandBuilder()
    .setName("fastforward")
    .setDescription("Jump forward in the current track.")
    .addIntegerOption((option) =>
      option.setName("seconds").setDescription("Seconds to jump").setRequired(true).setMinValue(1).setMaxValue(600)
    ),
  new SlashCommandBuilder()
    .setName("rewind")
    .setDescription("Jump backward in the current track.")
    .addIntegerOption((option) =>
      option.setName("seconds").setDescription("Seconds to jump").setRequired(true).setMinValue(1).setMaxValue(600)
    ),
  new SlashCommandBuilder()
    .setName("autoplay")
    .setDescription("Toggle autoplay for this guild.")
    .addBooleanOption((option) =>
      option.setName("enabled").setDescription("Whether autoplay should be enabled").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("voteskip")
    .setDescription("Moderators: toggle vote skip mode for this server.")
    .addBooleanOption((option) =>
      option.setName("enabled").setDescription("Whether vote skip should be enabled").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("filter")
    .setDescription("Apply or clear a playback filter preset.")
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
    .setDescription("Show or set the guild text-command prefix.")
    .addSubcommand((subcommand) =>
      subcommand.setName("show").setDescription("Show the current prefix.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Moderators: set the text-command prefix.")
        .addStringOption((option) =>
          option.setName("value").setDescription("New prefix").setRequired(true).setMaxLength(5)
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
      subcommand.setName("list").setDescription("List saved shock-lists for this guild.")
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
    ),
  new SlashCommandBuilder()
    .setName("owner")
    .setDescription("Bot-owner-only global commands.")
    .addSubcommand((subcommand) =>
      subcommand.setName("status").setDescription("Show bot owner status and runtime information.")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("synccommands").setDescription("Re-register the bot's slash commands.")
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
