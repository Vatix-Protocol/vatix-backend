/**
 * Oracle Scheduler
 *
 * Provides the configurable polling interval for oracle ingestion and
 * resolution checks. The interval is read from ORACLE_POLL_INTERVAL_MS
 * with lower and upper safety bounds enforced at startup.
 *
 * Recommended default : 30 000 ms (30 seconds)
 * Lower bound         : 5 000 ms  — prevents runaway polling under misconfiguration
 * Upper bound         : 3 600 000 ms (1 hour) — ensures checks are not indefinitely delayed
 *
 * @module apps/oracle/oracle-scheduler
 */

/** Minimum allowed polling interval (5 seconds). */
export const MIN_POLL_INTERVAL_MS = 5_000;

/** Maximum allowed polling interval (1 hour). */
export const MAX_POLL_INTERVAL_MS = 3_600_000;

/** Recommended default polling interval (30 seconds). */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Read and validate ORACLE_POLL_INTERVAL_MS from the environment.
 *
 * @returns Validated polling interval in milliseconds.
 * @throws {Error} If the value is present but outside the allowed bounds or not a positive integer.
 */
export function getOraclePollIntervalMs(): number {
  const raw = process.env["ORACLE_POLL_INTERVAL_MS"];

  if (raw === undefined || raw === "") {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `ORACLE_POLL_INTERVAL_MS must be a positive integer, got: ${JSON.stringify(raw)}`
    );
  }

  if (value < MIN_POLL_INTERVAL_MS) {
    throw new Error(
      `ORACLE_POLL_INTERVAL_MS must be >= ${MIN_POLL_INTERVAL_MS} ms (lower safety bound), got: ${value}`
    );
  }

  if (value > MAX_POLL_INTERVAL_MS) {
    throw new Error(
      `ORACLE_POLL_INTERVAL_MS must be <= ${MAX_POLL_INTERVAL_MS} ms (upper safety bound), got: ${value}`
    );
  }

  return value;
}
