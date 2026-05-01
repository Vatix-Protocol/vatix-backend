/**
 * API server config — thin re-export of the shared config loader.
 *
 * Loaded once at startup; the frozen object is passed to routes/middleware
 * rather than reading process.env directly.
 */
export type { NodeEnv, BaseConfig as Config } from "../packages/shared/src/config.js";
export { loadBaseConfig } from "../packages/shared/src/config.js";

export type NodeEnv = "development" | "test" | "production";

const ACCEPTED_NODE_ENVS: NodeEnv[] = ["development", "test", "production"];

/**
 * Validates DATABASE_URL is present and matches a postgresql:// or postgres:// URL.
 * Throws at startup if missing or malformed — never logs the full connection string.
 */
function loadDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;

  if (!raw || raw.trim() === "") {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "DATABASE_URL is not a valid URL (expected format: postgresql://user:pass@host:port/db)"
    );
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(
      `DATABASE_URL must use the postgresql:// or postgres:// scheme, got: ${JSON.stringify(parsed.protocol)}`
    );
  }

  if (!parsed.hostname) {
    throw new Error("DATABASE_URL must include a hostname");
  }

  return raw;
}

function loadNodeEnv(): NodeEnv {
  const raw = process.env.NODE_ENV ?? "development";
  if (!ACCEPTED_NODE_ENVS.includes(raw as NodeEnv)) {
    throw new Error(
      `NODE_ENV must be one of ${ACCEPTED_NODE_ENVS.join(" | ")}, got: ${JSON.stringify(raw)}`
    );
  }
  return raw as NodeEnv;
}

function requirePositiveInt(
  name: string,
  fallback?: number,
  max?: number
): number {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `Environment variable ${name} must be a positive integer, got: ${JSON.stringify(raw)}`
    );
  }

  if (max !== undefined && value > max) {
    throw new Error(
      `Environment variable ${name} must be <= ${max}, got: ${JSON.stringify(raw)}`
    );
  }

  return value;
}

/**
 * Loads ORACLE_POLL_INTERVAL_MS with lower and upper safety bounds.
 * Lower bound: 5 000 ms — prevents runaway polling under misconfiguration.
 * Upper bound: 3 600 000 ms (1 hour) — ensures checks are not indefinitely delayed.
 * Default: 30 000 ms (30 seconds).
 */
function loadOraclePollIntervalMs(): number {
  const MIN_POLL_INTERVAL_MS = 5_000;
  const MAX_POLL_INTERVAL_MS = 3_600_000;
  const DEFAULT_POLL_INTERVAL_MS = 30_000;

  const raw = process.env["ORACLE_POLL_INTERVAL_MS"];

  if (raw === undefined || raw === "") {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `Environment variable ORACLE_POLL_INTERVAL_MS must be a positive integer, got: ${JSON.stringify(raw)}`
    );
  }

  if (value < MIN_POLL_INTERVAL_MS) {
    throw new Error(
      `ORACLE_POLL_INTERVAL_MS must be >= ${MIN_POLL_INTERVAL_MS} ms, got: ${JSON.stringify(raw)}`
    );
  }

  if (value > MAX_POLL_INTERVAL_MS) {
    throw new Error(
      `ORACLE_POLL_INTERVAL_MS must be <= ${MAX_POLL_INTERVAL_MS} ms, got: ${JSON.stringify(raw)}`
    );
  }

  return value;
}

export const config = {
  /**
   * Current runtime environment. Constrained to development | test | production.
   * Configured via NODE_ENV (default: development).
   */
  nodeEnv: loadNodeEnv(),
  /**
   * TCP port the API server binds to.
   * Must be a positive integer in the range 1–65535.
   * Configured via PORT (default: 3000).
   */
  port: requirePositiveInt("PORT", 3000, 65535),
  /**
   * PostgreSQL connection string for the primary database.
   * Must be a valid postgresql:// or postgres:// URL.
   * Configured via DATABASE_URL — startup fails if missing or malformed.
   * Never logged in full to avoid leaking credentials.
   */
  databaseUrl: loadDatabaseUrl(),
  /**
   * Duration of the oracle resolution challenge window in seconds.
   * Must be a positive integer. All window boundary calculations use UTC.
   * Configured via ORACLE_CHALLENGE_WINDOW_SECONDS (default: 86400 = 24 h).
   */
  oracle: {
    challengeWindowSeconds: requirePositiveInt(
      "ORACLE_CHALLENGE_WINDOW_SECONDS",
      86400
    ),
    /**
     * How often the oracle scheduler polls for ingestion and resolution checks (ms).
     * Recommended default: 30 000 ms (30 seconds).
     * Lower bound: 5 000 ms — prevents runaway polling under misconfiguration.
     * Upper bound: 3 600 000 ms (1 hour) — ensures checks are not indefinitely delayed.
     * Configured via ORACLE_POLL_INTERVAL_MS.
     */
    pollIntervalMs: loadOraclePollIntervalMs(),
  },
} as const;
