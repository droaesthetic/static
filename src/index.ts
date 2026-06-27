import { createBot } from "./bot/createBot.js";
import { createDashboardServer } from "./dashboard/server.js";
import { appConfig } from "./config.js";
import { registerCrashHandler } from "./crashHandler.js";
import type { MusicManager } from "./music/musicManager.js";

const crashHandler = registerCrashHandler();

async function main() {
  let music: MusicManager | null = null;
  const app = createDashboardServer(() => music);

  const server = app.listen(appConfig.dashboardPort, () => {
    console.log(`Dashboard listening on ${appConfig.dashboardPublicUrl}`);
  });

  server.on("error", (error) => {
    console.error("[dashboard] server error", error);
  });

  crashHandler.addCleanupHandler(() => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  }));

  const bot = await createBot();
  music = bot.music;
  crashHandler.addCleanupHandler(() => {
    bot.client.destroy();
  });
}

main().catch((error) => {
  void crashHandler.shutdown("startup failure", error);
});
