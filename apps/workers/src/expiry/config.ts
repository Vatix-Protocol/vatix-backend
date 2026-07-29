export interface ExpiryWorkerConfig {
  intervalMs: number;
  maxRunMs: number;
  logLevel: string;
}

export function loadExpiryConfig(): ExpiryWorkerConfig {
  const intervalMs = parseInt(
    process.env.EXPIRY_WORKER_INTERVAL_MS ?? "60000",
    10
  );
  const maxRunMs = parseInt(process.env.EXPIRY_WORKER_MAX_RUN_MS ?? "30000", 10);
  const logLevel = process.env.LOG_LEVEL ?? "info";

  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error(
      `EXPIRY_WORKER_INTERVAL_MS must be >= 1000, got: ${intervalMs}`
    );
  }

  if (!Number.isFinite(maxRunMs) || maxRunMs < 0) {
    throw new Error(
      `EXPIRY_WORKER_MAX_RUN_MS must be >= 0, got: ${maxRunMs}`
    );
  }

  return { intervalMs, maxRunMs, logLevel };
}
