import type { LogLevel } from "../../../indexer/src/logger.js";

export interface ExpiryWorkerConfig {
  intervalMs: number;
  maxRunMs: number;
  logLevel: LogLevel;
}

const VALID_LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

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

  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error(
      `EXPIRY_WORKER_INTERVAL_MS must be >= 1000, got: ${intervalMs}`
    );
  }

  if (!Number.isFinite(maxRunMs) || maxRunMs < 0) {
    throw new Error(`EXPIRY_WORKER_MAX_RUN_MS must be >= 0, got: ${maxRunMs}`);
  }

  return { intervalMs, maxRunMs, logLevel };
}
