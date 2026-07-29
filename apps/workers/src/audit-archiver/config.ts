export interface AuditArchiverConfig {
  intervalMs: number;
  maxRunMs: number;
  batchSize: number;
  logLevel: string;
}

export function loadAuditArchiverConfig(): AuditArchiverConfig {
  const intervalMs = parseInt(
    process.env.AUDIT_ARCHIVER_INTERVAL_MS ?? "30000",
    10
  );
  const maxRunMs = parseInt(process.env.AUDIT_ARCHIVER_MAX_RUN_MS ?? "20000", 10);
  const batchSize = parseInt(process.env.AUDIT_ARCHIVER_BATCH_SIZE ?? "1000", 10);
  const logLevel = process.env.LOG_LEVEL ?? "info";

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

  return { intervalMs, maxRunMs, batchSize, logLevel };
}
