import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().optional(),
  LAVALINK_NAME: z.string().default("main"),
  LAVALINK_URL: z.string().default(""),
  LAVALINK_PASSWORD: z.string().default(""),
  LAVALINK_SECURE: z.coerce.boolean().default(false),
  YOUTUBE_API_KEY: z.string().default(""),
  SPOTIFY_CLIENT_ID: z.string().default(""),
  SPOTIFY_CLIENT_SECRET: z.string().default(""),
  PORT: z.coerce.number().optional(),
  DASHBOARD_PORT: z.coerce.number().optional(),
  DASHBOARD_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  DASHBOARD_AUTH_TOKEN: z.string().min(16),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_PREMIUM_PRICE_ID: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  PREMIUM_SOLO_USER_ID: z.string().default(""),
  BOT_OWNERS: z.string().default(""),
  BOT_MANAGERS: z.string().default(""),
  DEFAULT_VOLUME: z.coerce.number().min(1).max(150).default(75),
  MAX_QUEUE_SIZE: z.coerce.number().min(1).max(500).default(100),
  CHAT_COMMAND_DELETE_AFTER_SECONDS: z.coerce.number().min(0).max(3600).default(30)
});

const parsed = schema.parse(process.env);

export const appConfig = {
  discordToken: parsed.DISCORD_TOKEN,
  discordClientId: parsed.DISCORD_CLIENT_ID,
  discordGuildId: parsed.DISCORD_GUILD_ID,
  lavalink: parsed.LAVALINK_URL && parsed.LAVALINK_PASSWORD ? {
    name: parsed.LAVALINK_NAME,
    url: parsed.LAVALINK_URL,
    auth: parsed.LAVALINK_PASSWORD,
    secure: parsed.LAVALINK_SECURE
  } : null,
  youtubeApiKey: parsed.YOUTUBE_API_KEY || null,
  spotify: parsed.SPOTIFY_CLIENT_ID && parsed.SPOTIFY_CLIENT_SECRET ? {
    clientId: parsed.SPOTIFY_CLIENT_ID,
    clientSecret: parsed.SPOTIFY_CLIENT_SECRET
  } : null,
  dashboardPort: parsed.PORT ?? parsed.DASHBOARD_PORT ?? 3000,
  dashboardPublicUrl: parsed.DASHBOARD_PUBLIC_URL,
  dashboardAuthToken: parsed.DASHBOARD_AUTH_TOKEN,
  stripe: parsed.STRIPE_SECRET_KEY && parsed.STRIPE_PREMIUM_PRICE_ID ? {
    secretKey: parsed.STRIPE_SECRET_KEY,
    premiumPriceId: parsed.STRIPE_PREMIUM_PRICE_ID,
    webhookSecret: parsed.STRIPE_WEBHOOK_SECRET || null
  } : null,
  premiumSoloUserId: parsed.PREMIUM_SOLO_USER_ID.trim() || null,
  botOwners: parsed.BOT_OWNERS.split(",").map((value) => value.trim()).filter(Boolean),
  botManagers: parsed.BOT_MANAGERS.split(",").map((value) => value.trim()).filter(Boolean),
  defaultVolume: parsed.DEFAULT_VOLUME,
  maxQueueSize: parsed.MAX_QUEUE_SIZE,
  chatCommandDeleteAfterSeconds: parsed.CHAT_COMMAND_DELETE_AFTER_SECONDS
};
