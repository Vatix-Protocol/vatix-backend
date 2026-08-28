/**
 * API server config — validated at module load via Zod (see src/env.ts).
 */
import { parseApiEnv } from "./env.js";

const env = parseApiEnv();

export type NodeEnv = typeof env.NODE_ENV;

// Single source of truth (#984): every value below is read from the Zod-parsed
// `env` object. This module must never touch `process.env` directly — that
// would reintroduce a second, unvalidated parser. `src/config.test.ts` guards
// this with a source scan.

// Note: ADMIN_TOKEN is deprecated. Use AdminIdentity model for rotatable
// credentials. It is declared in the schema (src/env.ts) and rejected outright
// when NODE_ENV=production.

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
   * Max connections in the pg.Pool backing the Prisma adapter (#806).
   * Configured via DATABASE_POOL_SIZE (default: 10). See .env.example for
   * recommended values per environment.
   */
  databasePoolSize: env.DATABASE_POOL_SIZE,
  /**
   * Read-only PostgreSQL connection string for analytics/reporting queries (#743).
   * Intended to point at a read replica so heavy analytical queries don't
   * compete with the primary's write/OLTP workload.
   * Configured via ANALYTICS_DATABASE_URL — falls back to `databaseUrl` when unset.
   * Never logged in full to avoid leaking credentials.
   */
  analyticsDatabaseUrl: env.ANALYTICS_DATABASE_URL,
  /**
   * @deprecated Use AdminIdentity model for rotatable credentials.
   * Read from the Zod-parsed `env` (#984) — never `process.env` — so the value
   * passes through the single validated schema. Empty string when unset;
   * `parseApiEnv` rejects a non-empty value outright when NODE_ENV=production.
   */
  adminToken: env.ADMIN_TOKEN ?? "",
  /**
   * Per-transaction Postgres `statement_timeout` (ms) for unbounded read paths
   * such as `GET /v1/markets`, applied via `DatabaseService.withStatementTimeout`
   * (#983). A query that exceeds this is aborted by Postgres instead of pinning
   * a pool connection indefinitely.
   * Configured via DATABASE_STATEMENT_TIMEOUT_MS (default: 5000).
   */
  databaseStatementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
  /**
   * Feature flag: whether the matching engine accepts and matches new orders (#744).
   * When false, startup order-book hydration is skipped and placeOrder()
   * rejects with 503 Service Unavailable. Order cancellation is unaffected.
   * Configured via MATCHING_ENGINE_ENABLED (accepts "true" | "false", default: true).
   */
  matchingEngineEnabled: env.MATCHING_ENGINE_ENABLED,
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
