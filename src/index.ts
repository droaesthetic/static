import { createBot } from "./bot/createBot.js";
import { createDashboardServer } from "./dashboard/server.js";
import { appConfig } from "./config.js";
import type { MusicManager } from "./music/musicManager.js";

process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[process] uncaught exception", error);
});

process.on("warning", (warning) => {
  console.warn("[process] warning", warning);
});

process.on("exit", (code) => {
  console.log(`[process] exiting with code ${code}`);
});

async function main() {
  let music: MusicManager | null = null;
  const app = createDashboardServer(() => music);

  const server = app.listen(appConfig.dashboardPort, () => {
    console.log(`Dashboard listening on ${appConfig.dashboardPublicUrl}`);
  });

  server.on("error", (error) => {
    console.error("[dashboard] server error", error);
  });

  const bot = await createBot();
  music = bot.music;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
