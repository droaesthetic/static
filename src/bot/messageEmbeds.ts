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
  const title = options.title ?? BOT_BRAND_NAME;
  const styledDescription = description.startsWith("#") || description.startsWith("__") || description.startsWith("```")
    ? description
    : [`# __**${title.toUpperCase()}**__`, "", description].join("\n");

  return new EmbedBuilder() 
    .setColor(toneColors[options.tone ?? "info"]) 
    .setDescription(styledDescription) 
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
