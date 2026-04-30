import { EmbedBuilder } from "discord.js";
import { BOT_BRAND_NAME } from "../brand.js";

export type EmbedTone = "info" | "success" | "warning" | "error";

const toneColors: Record<EmbedTone, number> = {
  info: 0x2f3136,
  success: 0x57f287,
  warning: 0xfee75c,
  error: 0xed4245
};

export function buildBotEmbed(
  description: string,
  options: {
    title?: string;
    tone?: EmbedTone;
  } = {}
) {
  return new EmbedBuilder()
    .setColor(toneColors[options.tone ?? "info"])
    .setTitle(options.title ?? BOT_BRAND_NAME)
    .setDescription(description)
    .setTimestamp();
}

export function embedTextPayload(
  description: string,
  options: {
    title?: string;
    tone?: EmbedTone;
  } = {}
) {
  return {
    embeds: [buildBotEmbed(description, options)]
  };
}
