/**
 * API server config — validated at module load via Zod (see src/env.ts).
 */
import { parseApiEnv } from "./env.js";

const env = parseApiEnv();

export type NodeEnv = typeof env.NODE_ENV;

function requireString(name: string): string {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return raw.trim();
}

// Validate ADMIN_TOKEN at startup (except in test environment)
if (process.env.NODE_ENV !== "test") {
  requireString("ADMIN_TOKEN");
}

export const config = {
  /**
   * Current runtime environment. Constrained to development | test | production.
   * Configured via NODE_ENV (default: development).
   */
  nodeEnv: env.NODE_ENV,
  /**
   * TCP port the API server binds to.
   * Must be a positive integer in the range 1–65535.
   * Configured via PORT (default: 3000).
   */
  port: env.PORT,
  /**
   * PostgreSQL connection string for the primary database.
   * Must be a valid postgresql:// or postgres:// URL.
   * Configured via DATABASE_URL — startup fails if missing or malformed.
   * Never logged in full to avoid leaking credentials.
   */
  databaseUrl: env.DATABASE_URL,
  /**
   * Admin bearer token for protected admin endpoints.
   * Configured via ADMIN_TOKEN.
   */
  get adminToken(): string {
    return process.env.ADMIN_TOKEN || "";
  },
  /**
   * Duration of the oracle resolution challenge window in seconds.
   * Must be a positive integer. All window boundary calculations use UTC.
   * Configured via ORACLE_CHALLENGE_WINDOW_SECONDS (default: 86400 = 24 h).
   */
  oracle: {
    challengeWindowSeconds: env.ORACLE_CHALLENGE_WINDOW_SECONDS,
    /**
     * How often the oracle scheduler polls for ingestion and resolution checks (ms).
     * Recommended default: 30 000 ms (30 seconds).
     * Lower bound: 5 000 ms — prevents runaway polling under misconfiguration.
     * Upper bound: 3 600 000 ms (1 hour) — ensures checks are not indefinitely delayed.
     * Configured via ORACLE_POLL_INTERVAL_MS.
     */
    pollIntervalMs: env.ORACLE_POLL_INTERVAL_MS,
  },
} as const;
