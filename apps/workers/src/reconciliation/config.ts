export interface ReconciliationConfig {
  intervalMs: number;
  maxRunMs: number;
  autoRecoveryEnabled: boolean;
}

export function loadReconciliationConfig(): ReconciliationConfig {
  const intervalMs = parseInt(
    process.env.RECONCILIATION_INTERVAL_MS ?? "30000",
    10
  );
  const maxRunMs = parseInt(
    process.env.RECONCILIATION_MAX_RUN_MS ?? "20000",
    10
  );
  const autoRecoveryEnabled =
    process.env.AUTO_RECOVERY_ENABLED?.toLowerCase() === "true" ?? false;

  if (isNaN(intervalMs) || intervalMs < 1000) {
    throw new Error(
      `RECONCILIATION_INTERVAL_MS must be >= 1000, got ${intervalMs}`
    );
  }

  if (isNaN(maxRunMs) || maxRunMs < 1000) {
    throw new Error(
      `RECONCILIATION_MAX_RUN_MS must be >= 1000, got ${maxRunMs}`
    );
  }

  return {
    intervalMs,
    maxRunMs,
    autoRecoveryEnabled,
  };
}
