import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MusicManager } from "../music/musicManager.js";
import { appConfig } from "../config.js";
import { StripeBillingService } from "../billing/stripeBilling.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const publicDir = path.resolve(currentDir, "../../static");

export function createDashboardServer(getMusic: () => MusicManager | null) {
  const app = express();
  const guildId = (request: express.Request) => String(request.params.guildId ?? "");

  const withMusic = (handler: (music: MusicManager, request: express.Request, response: express.Response) => void | Promise<void>) =>
    async (request: express.Request, response: express.Response) => {
      const music = getMusic();
      if (!music) {
        response.status(503).json({ error: "Bot is still starting up." });
        return;
      }

      try {
        await handler(music, request, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Dashboard request failed.";
        response.status(500).json({ error: message });
      }
    };

  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), withMusic(async (music, request, response) => {
    const event = StripeBillingService.verifyAndParseWebhook(
      Buffer.isBuffer(request.body) ? request.body : Buffer.from(String(request.body ?? ""), "utf8"),
      request.headers["stripe-signature"]?.toString()
    );
    const sync = await StripeBillingService.resolvePremiumSyncFromEvent(event);
    if (sync) {
      await music.syncPremiumSubscription(sync);
    }

    response.json({ received: true });
  }));

  app.use(express.json());

  app.use((request, response, next) => {
    if (
      request.path === "/" ||
      request.path === "/health" ||
      request.path === "/api/stripe/webhook" ||
      request.path.startsWith("/assets")
    ) {
      next();
      return;
    }

    const authHeader = request.headers.authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, "") || request.query.token;
    if (token !== appConfig.dashboardAuthToken) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  });

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/players", withMusic((music, _request, response) => {
    response.json({
      publicUrl: appConfig.dashboardPublicUrl,
      players: music.listSnapshots()
    });
  }));

  app.get("/api/players/:guildId/audit-logs", withMusic(async (music, request, response) => {
    const rawLimit = Number.parseInt(String(request.query.limit ?? "20"), 10);
    const limit = Number.isInteger(rawLimit) ? rawLimit : 20;
    response.json({ auditLogs: await music.listAuditLogs(guildId(request), limit) });
  }));

  app.post("/api/players/:guildId/pause", withMusic(async (music, request, response) => {
    await music.pause(guildId(request));
    response.json({ ok: true });
  }));

  app.post("/api/players/:guildId/resume", withMusic(async (music, request, response) => {
    await music.resume(guildId(request));
    response.json({ ok: true });
  }));

  app.post("/api/players/:guildId/skip", withMusic(async (music, request, response) => {
    await music.skip(guildId(request));
    response.json({ ok: true });
  }));

  app.post("/api/players/:guildId/stop", withMusic(async (music, request, response) => {
    await music.stop(guildId(request));
    response.json({ ok: true });
  }));

  app.post("/api/players/:guildId/volume", withMusic(async (music, request, response) => {
    const { percent } = request.body as { percent?: number };
    if (typeof percent !== "number") {
      response.status(400).json({ error: "percent is required" });
      return;
    }

    await music.setVolume(guildId(request), percent);
    response.json({ ok: true });
  }));

  app.use("/assets", express.static(path.join(publicDir, "assets")));

  app.get("/", (_request, response) => {
    response.sendFile(path.join(publicDir, "index.html"));
  });

  return app;
}
