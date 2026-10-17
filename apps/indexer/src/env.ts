export { validateEnv, EnvValidationError } from "./config.js";

/**
 * Stable error codes for startup health checks.
 * These are part of the public contract for ops tooling and must not change
 * without a coordinated runbook update.
 */
export const StartupHealthErrorCode = {
  REDIS_MISSING: "STARTUP_HEALTH_REDIS_MISSING",
  REDIS_UNREACHABLE: "STARTUP_HEALTH_REDIS_UNREACHABLE",
  REDIS_PING_FAILED: "STARTUP_HEALTH_REDIS_PING_FAILED",
} as const;

export type StartupHealthErrorCode =
  (typeof StartupHealthErrorCode)[keyof typeof StartupHealthErrorCode];

/**
 * Fail-closed error raised when a required startup dependency (Redis) is
 * missing or unreachable. Callers must treat this as fatal: the indexer must
 * not proceed to process money-path events without a healthy Redis.
 */
export class StartupHealthError extends Error {
  readonly code: StartupHealthErrorCode;
  readonly correlationId: string;

  constructor(
    code: StartupHealthErrorCode,
    message: string,
    correlationId: string,
  ) {
    super(message);
    this.name = "StartupHealthError";
    this.code = code;
    this.correlationId = correlationId;
  }
}

/**
 * Minimal Redis surface required for the startup health probe. Kept structural
 * so tests can inject a fake without pulling in a concrete client.
 */
export interface StartupRedisClient {
  ping(): Promise<unknown>;
}

export interface StartupHealthLogger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/**
 * Ops-safe metrics sink. Implementations must not receive secrets; only the
 * stable error code and correlation id are forwarded.
 */
export interface StartupHealthMetrics {
  increment(
    name: string,
    tags: { code?: StartupHealthErrorCode; outcome: "ok" | "fail" },
  ): void;
}

const REDIS_URL_ENV = "REDIS_URL";
const CORS_ALLOWED_ORIGINS_ENV = "INDEXER_CORS_ALLOWED_ORIGINS";

/**
 * Resolve the Redis URL from the environment without ever logging its value.
 * Returns undefined when unset or blank so callers can fail closed.
 */
export function resolveRedisUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env[REDIS_URL_ENV];
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse and validate the optional INDEXER_CORS_ALLOWED_ORIGINS allowlist.
 *
 * The variable is a comma-separated list of origins (e.g.
 * "https://app.example.com,https://admin.example.com"). When unset or blank
 * the result is an empty list, which callers interpret as "wildcard mode" so
 * existing behaviour is preserved. Each entry must be a valid absolute origin
 * (scheme + host, optional port, no path/query/fragment); invalid entries
 * throw so misconfiguration fails fast at startup.
 */
export function resolveCorsAllowedOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env[CORS_ALLOWED_ORIGINS_ENV];
  if (typeof raw !== "string") {
    return [];
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const origins: string[] = [];
  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error(
        `Invalid ${CORS_ALLOWED_ORIGINS_ENV} entry: ${JSON.stringify(entry)} is not a valid origin`,
      );
    }
    if (
      parsed.origin === "null" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error(
        `Invalid ${CORS_ALLOWED_ORIGINS_ENV} entry: ${JSON.stringify(entry)} must be an origin (scheme://host[:port])`,
      );
    }
    origins.push(parsed.origin);
  }
  return origins;
}

/**
 * Generate a correlation id for a startup health attempt. Uses crypto.randomUUID
 * when available and falls back to a timestamp-based id otherwise.
 */
export function newStartupCorrelationId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `startup-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Fail-closed startup health check for Redis.
 *
 * Invariants:
 *  - Missing/blank REDIS_URL => StartupHealthError(REDIS_MISSING).
 *  - Client construction failure or ping rejection => StartupHealthError
 *    (REDIS_UNREACHABLE / REDIS_PING_FAILED).
 *  - Never logs the Redis URL or credentials; only code + correlation id.
 *  - Emits an ops-safe metric on both success and failure.
 */
export async function assertStartupRedisHealthy(options: {
  env?: Record<string, string | undefined>;
  createClient?: (url: string) => StartupRedisClient;
  logger?: StartupHealthLogger;
  metrics?: StartupHealthMetrics;
  correlationId?: string;
}): Promise<{ correlationId: string }> {
  const correlationId = options.correlationId ?? newStartupCorrelationId();
  const logger = options.logger;
  const metrics = options.metrics;

  const url = resolveRedisUrl(options.env);
  if (!url) {
    const error = new StartupHealthError(
      StartupHealthErrorCode.REDIS_MISSING,
      "Startup health failed closed: REDIS_URL is not configured",
      correlationId,
    );
    logger?.error(
      { code: error.code, correlationId },
      "startup health: redis missing",
    );
    metrics?.increment("indexer_startup_health", {
      code: error.code,
      outcome: "fail",
    });
    throw error;
  }

  const createClient = options.createClient;
  if (!createClient) {
    const error = new StartupHealthError(
      StartupHealthErrorCode.REDIS_UNREACHABLE,
      "Startup health failed closed: no Redis client factory configured",
      correlationId,
    );
    logger?.error(
      { code: error.code, correlationId },
      "startup health: redis client unavailable",
    );
    metrics?.increment("indexer_startup_health", {
      code: error.code,
      outcome: "fail",
    });
    throw error;
  }

  let client: StartupRedisClient;
  try {
    client = createClient(url);
  } catch {
    const error = new StartupHealthError(
      StartupHealthErrorCode.REDIS_UNREACHABLE,
      "Startup health failed closed: could not construct Redis client",
      correlationId,
    );
    logger?.error(
      { code: error.code, correlationId },
      "startup health: redis client construction failed",
    );
    metrics?.increment("indexer_startup_health", {
      code: error.code,
      outcome: "fail",
    });
    throw error;
  }

  try {
    await client.ping();
  } catch {
    const error = new StartupHealthError(
      StartupHealthErrorCode.REDIS_PING_FAILED,
      "Startup health failed closed: Redis ping did not succeed",
      correlationId,
    );
    logger?.error(
      { code: error.code, correlationId },
      "startup health: redis ping failed",
    );
    metrics?.increment("indexer_startup_health", {
      code: error.code,
      outcome: "fail",
    });
    throw error;
  }

  logger?.info(
    { correlationId },
    "startup health: redis reachable",
  );
  metrics?.increment("indexer_startup_health", { outcome: "ok" });
  return { correlationId };
}
