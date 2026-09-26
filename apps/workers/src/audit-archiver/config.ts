import type { LogLevel } from "../../../indexer/src/logger.js";

export interface AuditArchiverConfig {
  intervalMs: number;
  maxRunMs: number;
  batchSize: number;
  logLevel: LogLevel;
  /**
   * Days of archived audit history to keep. `0` (default) disables retention
   * deletes entirely — see `retention.ts` for the full invariant set.
   */
  retentionDays: number;
  /** Max rows a single retention run may delete. */
  retentionBatchSize: number;
  /** Min rows always kept per market so the chain head stays verifiable. */
  retentionMinPerMarket: number;
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

export function loadAuditArchiverConfig(): AuditArchiverConfig {
  const intervalMs = parseInt(
    process.env.AUDIT_ARCHIVER_INTERVAL_MS ?? "30000",
    10
  );
  const maxRunMs = parseInt(
    process.env.AUDIT_ARCHIVER_MAX_RUN_MS ?? "20000",
    10
  );
  const batchSize = parseInt(
    process.env.AUDIT_ARCHIVER_BATCH_SIZE ?? "1000",
    10
  );
  const logLevel = parseLogLevel(process.env.LOG_LEVEL);

  // Retention is fail-closed: an unset or zero value disables deletes.
  const retentionDays = parseInt(
    process.env.AUDIT_ARCHIVE_RETENTION_DAYS ?? "0",
    10
  );
  const retentionBatchSize = parseInt(
    process.env.AUDIT_ARCHIVE_RETENTION_BATCH_SIZE ?? "1000",
    10
  );
  const retentionMinPerMarket = parseInt(
    process.env.AUDIT_ARCHIVE_RETENTION_MIN_PER_MARKET ?? "1",
    10
  );

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

  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error(
      `AUDIT_ARCHIVE_RETENTION_DAYS must be >= 0 (0 disables retention), got: ${retentionDays}`
    );
  }

  if (!Number.isFinite(retentionBatchSize) || retentionBatchSize < 1) {
    throw new Error(
      `AUDIT_ARCHIVE_RETENTION_BATCH_SIZE must be >= 1, got: ${retentionBatchSize}`
    );
  }

  if (!Number.isFinite(retentionMinPerMarket) || retentionMinPerMarket < 1) {
    throw new Error(
      `AUDIT_ARCHIVE_RETENTION_MIN_PER_MARKET must be >= 1, got: ${retentionMinPerMarket}`
    );
  }

  return {
    intervalMs,
    maxRunMs,
    batchSize,
    logLevel,
    retentionDays,
    retentionBatchSize,
    retentionMinPerMarket,
  };
}
