import type { Logger } from "../../../indexer/src/logger.js";

export const VALID_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type ShutdownSignal = (typeof VALID_SHUTDOWN_SIGNALS)[number];

export interface ShutdownDeps {
  logger: Logger;
  timer: ReturnType<typeof setInterval>;
  disconnectPrisma: () => Promise<void>;
  exit: (code: number) => void;
}

/**
 * Creates a graceful shutdown handler for the finalization worker.
 * Accepts injected deps so it can be unit-tested without process.exit side-effects.
 */
export function createShutdownHandler(deps: ShutdownDeps) {
  let isShuttingDown = false;

  return async (signal: string): Promise<void> => {
    if (
      typeof signal !== "string" ||
      signal.trim() === "" ||
      !VALID_SHUTDOWN_SIGNALS.includes(signal as ShutdownSignal)
    ) {
      deps.logger.warn("Graceful shutdown called with invalid signal", {
        signal,
        statusCode: 400,
        component: "finalization-worker",
        validSignals: [...VALID_SHUTDOWN_SIGNALS],
      });
      return;
    }

    if (isShuttingDown) return;
    isShuttingDown = true;

    deps.logger.info("Finalization worker shutdown initiated", {
      signal,
      component: "finalization-worker",
      status: "initiated",
    });
    clearInterval(deps.timer);

    try {
      await deps.disconnectPrisma();
      deps.logger.info("Finalization worker shutdown complete", {
        signal,
        component: "finalization-worker",
        status: "complete",
        exitCode: 0,
      });
      deps.exit(0);
    } catch (error) {
      deps.logger.error("Finalization worker shutdown failed", {
        signal,
        component: "finalization-worker",
        status: "failed",
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error),
      });
      deps.exit(1);
    }
  };
}
