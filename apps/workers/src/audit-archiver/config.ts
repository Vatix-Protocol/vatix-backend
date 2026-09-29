import type { LogLevel } from "../../../indexer/src/logger.js";

export interface AuditArchiverConfig {
  intervalMs: number;
  maxRunMs: number;
  batchSize: number;
  logLevel: LogLevel;
}

const VALID_LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

/**
 * Ceilings enforced at boot. See the checks in
 * {@link loadAuditArchiverConfig} for why each one is a bound rather than a
 * suggestion.
 */
export const MAX_BATCH_SIZE = 10_000;
export const MAX_RUN_MS = 300_000;

function parseLogLevel(raw: string | undefined): LogLevel {
  const level = (raw ?? "info").toLowerCase();
  if (!VALID_LOG_LEVELS.has(level as LogLevel)) {
    throw new Error(
      `LOG_LEVEL must be one of debug|info|warn|error, got: ${raw}`
    );
  }
  return level as LogLevel;
}

/**
 * Parse a strictly-numeric environment value.
 *
 * `parseInt` is deliberately not used: it accepts a valid numeric *prefix* and
 * ignores the rest, so `AUDIT_ARCHIVER_BATCH_SIZE=1000; DROP TABLE trades`
 * parses as `1000` and boots with a value the operator never intended. A
 * malformed value is a configuration bug, and the archiver controls trade-audit
 * retention, so it fails closed instead of guessing.
 */
function parseStrictInt(name: string, raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value === "") return Number.NaN;
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
  return Number.parseInt(value, 10);
}

export function loadAuditArchiverConfig(): AuditArchiverConfig {
  const intervalMs = parseStrictInt(
    "AUDIT_ARCHIVER_INTERVAL_MS",
    process.env.AUDIT_ARCHIVER_INTERVAL_MS ?? "30000"
  );
  const maxRunMs = parseStrictInt(
    "AUDIT_ARCHIVER_MAX_RUN_MS",
    process.env.AUDIT_ARCHIVER_MAX_RUN_MS ?? "20000"
  );
  const batchSize = parseStrictInt(
    "AUDIT_ARCHIVER_BATCH_SIZE",
    process.env.AUDIT_ARCHIVER_BATCH_SIZE ?? "1000"
  );
  const logLevel = parseLogLevel(process.env.LOG_LEVEL);

  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error(
      `AUDIT_ARCHIVER_INTERVAL_MS must be >= 1000, got: ${intervalMs}`
    );
  }

  if (!Number.isFinite(maxRunMs) || maxRunMs < 0) {
    throw new Error(`AUDIT_ARCHIVER_MAX_RUN_MS must be >= 0, got: ${maxRunMs}`);
  }

  if (!Number.isFinite(batchSize) || batchSize < 1) {
    throw new Error(
      `AUDIT_ARCHIVER_BATCH_SIZE must be >= 1, got: ${batchSize}`
    );
  }

  // Upper bounds, not tuning advice. An unbounded batch size lets one poll hold
  // an arbitrarily large slice of the trade-audit stream in memory and hold a
  // matching Postgres transaction open, so a typo'd value turns into an
  // availability incident during exactly the backlog the archiver exists to
  // drain. Loop over batches instead.
  if (batchSize > MAX_BATCH_SIZE) {
    throw new Error(
      `AUDIT_ARCHIVER_BATCH_SIZE must be <= ${MAX_BATCH_SIZE}, got: ${batchSize}`
    );
  }

  if (maxRunMs > MAX_RUN_MS) {
    throw new Error(
      `AUDIT_ARCHIVER_MAX_RUN_MS must be <= ${MAX_RUN_MS}, got: ${maxRunMs}`
    );
  }

  if (intervalMs < maxRunMs) {
    throw new Error(
      `AUDIT_ARCHIVER_INTERVAL_MS (${intervalMs}) must be >= AUDIT_ARCHIVER_MAX_RUN_MS (${maxRunMs}), otherwise every run overruns its own interval and the worker never idles`
    );
  }

  return { intervalMs, maxRunMs, batchSize, logLevel };
}
