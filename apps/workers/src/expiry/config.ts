import type { LogLevel } from "../../../indexer/src/logger.js";

export interface ExpiryWorkerConfig {
  intervalMs: number;
  maxRunMs: number;
  logLevel: LogLevel;
  clockSkewToleranceMs: number;
}

const VALID_LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

/**
 * Default grace period (ms) applied after a market's `endTime` before the
 * expiry worker treats it as expired. Guards against a host clock running
 * fast relative to the Stellar ledger close time: without it, a market whose
 * `endTime` is still in the future on-chain could be cancelled early.
 *
 * Non-zero in every environment (issue #1480) so dev/test exercise the same
 * skew behaviour as production. Override with
 * `EXPIRY_CLOCK_SKEW_TOLERANCE_MS`.
 */
export const DEFAULT_EXPIRY_CLOCK_SKEW_TOLERANCE_MS = 5000;

function parseLogLevel(raw: string | undefined): LogLevel {
  const level = (raw ?? "info").toLowerCase();
  if (!VALID_LOG_LEVELS.has(level as LogLevel)) {
    throw new Error(
      `LOG_LEVEL must be one of debug|info|warn|error, got: ${raw}`
    );
  }
  return level as LogLevel;
}

export function loadExpiryConfig(): ExpiryWorkerConfig {
  const intervalMs = parseInt(
    process.env.EXPIRY_WORKER_INTERVAL_MS ?? "60000",
    10
  );
  const maxRunMs = parseInt(
    process.env.EXPIRY_WORKER_MAX_RUN_MS ?? "30000",
    10
  );
  const logLevel = parseLogLevel(process.env.LOG_LEVEL);

  // Containers run on schedulers/nodes whose clocks are not guaranteed to be
  // NTP-synced to the same tolerance as the Stellar ledger. Default to a 5s
  // grace period in every environment so a fast host clock cannot silently
  // expire markets ahead of the actual ledger close time.
  const clockSkewToleranceMs = parseInt(
    process.env.EXPIRY_CLOCK_SKEW_TOLERANCE_MS ??
      String(DEFAULT_EXPIRY_CLOCK_SKEW_TOLERANCE_MS),
    10
  );

  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error(
      `EXPIRY_WORKER_INTERVAL_MS must be >= 1000, got: ${intervalMs}`
    );
  }

  if (!Number.isFinite(maxRunMs) || maxRunMs < 0) {
    throw new Error(`EXPIRY_WORKER_MAX_RUN_MS must be >= 0, got: ${maxRunMs}`);
  }

  if (!Number.isFinite(clockSkewToleranceMs) || clockSkewToleranceMs < 0) {
    throw new Error(
      `EXPIRY_CLOCK_SKEW_TOLERANCE_MS must be >= 0, got: ${clockSkewToleranceMs}`
    );
  }

  if (process.env.NODE_ENV === "production" && clockSkewToleranceMs === 0) {
    throw new Error(
      "EXPIRY_CLOCK_SKEW_TOLERANCE_MS must be > 0 in production; " +
        `omit it to use the default of ${DEFAULT_EXPIRY_CLOCK_SKEW_TOLERANCE_MS}ms`
    );
  }

  return { intervalMs, maxRunMs, logLevel, clockSkewToleranceMs };
}
