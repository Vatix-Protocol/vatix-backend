/**
 * Cross-Process Shutdown Coordination (#706)
 *
 * Provides a reusable graceful-shutdown handler that standardises the pattern
 * used by every long-running worker in the codebase. Each worker calls
 * `createShutdown()` at bootstrap, registers OS signals, and relies on the
 * returned handler to:
 *
 *   - Validate the incoming OS signal (only SIGINT / SIGTERM / SIGHUP are accepted)
 *   - Guard against duplicate shutdown calls (race-condition safe via a flag)
 *   - Enforce a configurable hard timeout after which `process.exit(1)` is forced
 *   - Accept an arbitrary list of teardown functions (close DB connections, stop
 *     queue consumers, clear timers, etc.)
 *
 * Usage:
 *
 * ```ts
 * import { createShutdown } from "../../../packages/shared/src/shutdown.js";
 *
 * const shutdown = createShutdown(logger, {
 *   timeoutMs: 30_000,
 *   teardown: [
 *     () => disconnectPrisma(),
 *     () => worker.close(),
 *   ],
 * });
 *
 * process.on("SIGINT", () => void shutdown("SIGINT"));
 * process.on("SIGTERM", () => void shutdown("SIGTERM"));
 * ```
 *
 * @module packages/shared/src/shutdown
 */

/**
 * Valid OS shutdown signals recognised by every worker.
 * Constrained to the three signals the workers handle.
 */
export type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

/** Set of all valid shutdown signals for fast O(1) lookup. */
const VALID_SHUTDOWN_SIGNALS = new Set<ShutdownSignal>([
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
]);

/**
 * Configuration for {@link createShutdown}.
 */
export interface ShutdownConfig {
  /**
   * Hard timeout in milliseconds. If teardown takes longer than this,
   * `process.exit(1)` is called. Defaults to 30_000 (30 seconds).
   */
  timeoutMs?: number;

  /**
   * Ordered list of async teardown callbacks. Each is awaited in sequence.
   * Common entries: disconnectPrisma(), redis.disconnect(), worker.close(), etc.
   */
  teardown?: Array<() => Promise<void>>;

  /**
   * Optional label used in log messages to identify the shutting-down process.
   * E.g. "oracle-worker", "finalization-worker", "settlement-worker".
   */
  component?: string;
}

/**
 * Creates a standardised graceful-shutdown handler.
 *
 * The returned function is safe to pass directly as an OS signal handler
 * because it guards against re-entry via an internal `isShuttingDown` flag.
 *
 * @param logger - A logger instance with `info`, `warn`, `error` methods.
 * @param config - Shutdown configuration.
 * @returns An async function that accepts a {@link ShutdownSignal} and
 *   orchestrates graceful teardown.
 */
export function createShutdown(
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  },
  config: ShutdownConfig = {}
): (signal: ShutdownSignal) => Promise<void> {
  const { timeoutMs = 30_000, teardown = [], component = "unknown" } = config;

  let isShuttingDown = false;

  return async (signal: ShutdownSignal): Promise<void> => {
    // Validate signal
    if (!VALID_SHUTDOWN_SIGNALS.has(signal)) {
      logger.warn("Graceful shutdown called with invalid signal", {
        signal,
        component,
        statusCode: 400,
        validSignals: [...VALID_SHUTDOWN_SIGNALS],
      });
      return;
    }

    // Guard against duplicate calls
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("Shutdown initiated", {
      signal,
      component,
      status: "initiated",
    });

    // Hard timeout to force exit if teardown hangs
    const timeoutHandle = setTimeout(() => {
      logger.error("Shutdown timeout exceeded, forcing exit", {
        signal,
        component,
        timeoutMs,
      });
      process.exit(1);
    }, timeoutMs);

    try {
      // Execute each teardown callback in sequence
      for (const teardownFn of teardown) {
        await teardownFn();
      }
      clearTimeout(timeoutHandle);

      logger.info("Shutdown complete", {
        signal,
        component,
        status: "complete",
        exitCode: 0,
      });
      process.exit(0);
    } catch (error) {
      clearTimeout(timeoutHandle);
      logger.error("Shutdown failed", {
        signal,
        component,
        status: "failed",
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };
}
