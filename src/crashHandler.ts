type CleanupHandler = () => void | Promise<void>;

interface CrashHandlerOptions {
  cleanupTimeoutMs?: number;
  handlers?: CleanupHandler[];
}

const defaultCleanupTimeoutMs = 10_000;
const crashExitCode = 1;
let isShuttingDown = false;

function formatReason(reason: unknown) {
  return reason instanceof Error ? reason.stack ?? reason.message : reason;
}

function withTimeout(handler: CleanupHandler, timeoutMs: number) {
  return Promise.race([
    Promise.resolve().then(handler),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs).unref?.();
    })
  ]);
}

export function registerCrashHandler(options: CrashHandlerOptions = {}) {
  const handlers = options.handlers ?? [];
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? defaultCleanupTimeoutMs;

  async function shutdown(kind: string, reason: unknown, exitCode = crashExitCode) {
    if (isShuttingDown) {
      console.error(`[process] ${kind} while shutdown is already in progress`, formatReason(reason));
      return;
    }

    isShuttingDown = true;
    console.error(`[process] ${kind}`, formatReason(reason));

    for (const handler of handlers) {
      try {
        await withTimeout(handler, cleanupTimeoutMs);
      } catch (error) {
        console.error("[process] cleanup handler failed", error);
      }
    }

    process.exit(exitCode);
  }

  process.on("unhandledRejection", (reason) => {
    void shutdown("unhandled promise rejection", reason);
  });

  process.on("uncaughtException", (error) => {
    void shutdown("uncaught exception", error);
  });

  process.on("SIGINT", () => {
    void shutdown("received SIGINT", "Interrupted by user", 0);
  });

  process.on("SIGTERM", () => {
    void shutdown("received SIGTERM", "Termination requested", 0);
  });

  process.on("warning", (warning) => {
    console.warn("[process] warning", warning);
  });

  process.on("exit", (code) => {
    console.log(`[process] exiting with code ${code}`);
  });

  return {
    addCleanupHandler(handler: CleanupHandler) {
      handlers.push(handler);
    },
    shutdown
  };
}
