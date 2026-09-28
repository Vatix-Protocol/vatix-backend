import fastify, { type FastifyInstance } from "fastify";
import type { Registry } from "prom-client";
import { indexerCorsPlugin } from "./middleware/cors.js";
import { marketsRoutes } from "./routes/markets.js";

/**
 * Stable error codes for probe and auth responses.  Kept as a closed
 * union so callers and dashboards can branch on exact strings rather
 * than free-form messages.
 */
export type ProbeErrorCode =
  | "NOT_READY"
  | "DEPENDENCY_UNAVAILABLE"
  | "UNAUTHORIZED";

/**
 * Stable error codes for rate-limit responses. Kept as a closed union so
 * clients and dashboards can branch on exact strings rather than free-form
 * messages (see RATE_LIMIT_POLICY.md).
 */
export type RateLimitErrorCode = "RATE_LIMITED";

/**
 * Stable error codes for indexer authz failures. Kept as a closed union
 * so clients and dashboards can branch on exact strings.
 */
export type MarketErrorCode = "UNAUTHORIZED" | "MARKET_NOT_FOUND" | "MARKET_QUERY_FAILED";

/**
 * Stable error codes for indexer lag SLO responses (#1178). Kept as a closed
 * union so clients and dashboards can branch on exact strings rather than
 * free-form messages.
 */
export type IndexerLagErrorCode =
  | "INDEXER_LAG_SLO_BREACH"
  | "INDEXER_LAG_UNAVAILABLE";

/**
 * A single critical dependency check. `check` must resolve when the
 * dependency is reachable and reject (or throw) otherwise. It must never
 * return connection strings, credentials, or internal addresses — only a
 * boolean-ish signal — so probe output stays safe to expose.
 */
export interface ReadinessCheck {
  /** Stable, non-sensitive identifier, e.g. "db", "redis", "rpc". */
  name: string;
  check: () => Promise<void>;
}

/**
 * Readiness probe result. `checks` maps each dependency name to "ok" or
 * "unavailable"; no error details, hosts, or credentials are included.
 */
export interface ReadinessResult {
  ready: boolean;
  code?: ProbeErrorCode;
  correlationId: string;
  checks: Record<string, "ok" | "unavailable">;
}

/**
 * Minimal structured logger surface. Kept narrow so the probe never depends
 * on a specific logging implementation and never logs raw error objects
 * (which may embed connection strings).
 */
export interface ProbeLogger {
  info: (fields: Record<string, unknown>, msg: string) => void;
  warn: (fields: Record<string, unknown>, msg: string) => void;
}

/**
 * Rate-limit policy for a single external entrypoint. `limit` is the maximum
 * number of requests allowed per `windowMs` for a given client key. The
 * policy is deny-by-default: any entrypoint without an explicit policy is
 * rejected rather than served unlimited (RATE_LIMIT_POLICY.md).
 */
export interface RateLimitPolicy {
  /** Maximum requests permitted within the window. Must be > 0. */
  limit: number;
  /** Sliding/fixed window length in milliseconds. Must be > 0. */
  windowMs: number;
}

/**
 * Per-entrypoint rate-limit policies keyed by route path. Only paths listed
 * here are served; everything else fails closed with RATE_LIMITED so a new
 * route cannot silently ship without a policy.
 *
 * Probes (/health, /ready) are included so they are rate-limited like
 * every other external entrypoint (deny-by-default).  They use generous
 * limits because orchestrators and load balancers may poll them frequently.
 */
export const RATE_LIMIT_POLICIES: Record<string, RateLimitPolicy> = {
  "/health": { limit: 30, windowMs: 60_000 },
  "/ready": { limit: 30, windowMs: 60_000 },
  "/markets": { limit: 60, windowMs: 60_000 },
  "/markets/:id": { limit: 120, windowMs: 60_000 },
};

/**
 * Minimal counter store surface. Implementations may be in-memory (single
 * process) or Redis-backed (multi-instance). `increment` must be atomic and
 * return the new count for the key within the current window; it must reject
 * on dependency outage so callers can fail closed.
 */
export interface RateLimitStore {
  increment: (key: string, windowMs: number) => Promise<number>;
}

/**
 * In-memory fixed-window counter store. Suitable for single-process
 * deployments and tests; multi-instance deployments should supply a
 * Redis-backed store so limits are shared across replicas.
 */
export function createInMemoryRateLimitStore(
  now: () => number = Date.now,
): RateLimitStore {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    async increment(key, windowMs) {
      const ts = now();
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= ts) {
        buckets.set(key, { count: 1, resetAt: ts + windowMs });
        return 1;
      }
      existing.count += 1;
      return existing.count;
    },
  };
}

/**
 * Derives the client key used for rate limiting. Prefers the authenticated
 * principal when present so an untrusted client cannot bypass the policy by
 * rotating source addresses; falls back to the socket address otherwise.
 * Never includes credentials or tokens in the key.
 */
export function rateLimitKey(
  routePath: string,
  principal: string | undefined,
  remoteAddress: string | undefined,
): string {
  const identity = principal ?? remoteAddress ?? "unknown";
  return `${routePath}:${identity}`;
}

/**
 * Runs every readiness check concurrently and fails closed: any rejected or
 * thrown check marks the dependency "unavailable" and the overall result
 * not-ready. Never surfaces the underlying error message.
 */
export async function runReadinessChecks(
  checks: ReadinessCheck[],
  correlationId: string,
  logger?: ProbeLogger,
): Promise<ReadinessResult> {
  const results: Record<string, "ok" | "unavailable"> = {};
  await Promise.all(
    checks.map(async ({ name, check }) => {
      try {
        await check();
        results[name] = "ok";
      } catch {
        results[name] = "unavailable";
      }
    }),
  );

  const ready = checks.every(({ name }) => results[name] === "ok");
  const result: ReadinessResult = {
    ready,
    correlationId,
    checks: results,
  };
  if (!ready) {
    result.code = "DEPENDENCY_UNAVAILABLE";
  }

  if (logger) {
    const fields = { correlationId, ready, checks: results };
    if (ready) {
      logger.info(fields, "readiness probe ok");
    } else {
      logger.warn(fields, "readiness probe failed");
    }
  }

  return result;
}

/**
 * Indexer lag SLO configuration (#1178). `targetLagSeconds` is the maximum
 * acceptable gap between the chain head and the indexer's last processed
 * block; `maxStalenessSeconds` bounds how old the last successful sample may
 * be before the SLO is treated as unmeasurable. Both must be > 0. Semantics
 * match docs/metrics.md (indexer_lag_seconds gauge vs. SLO target).
 */
export interface IndexerLagSlo {
  /** Maximum acceptable indexer lag, in seconds. Must be > 0. */
  targetLagSeconds: number;
  /** Maximum age of the last sample before it is considered stale. Must be > 0. */
  maxStalenessSeconds: number;
}

/**
 * A single indexer lag sample. `lagSeconds` is the observed gap between the
 * chain head and the last processed block; `observedAtMs` is the wall-clock
 * time the sample was taken. Neither field may carry secrets or addresses.
 */
export interface IndexerLagSample {
  lagSeconds: number;
  observedAtMs: number;
}

/**
 * Result of evaluating the indexer lag SLO. `withinSlo` is true only when a
 * fresh sample exists and its lag is at or below the target. `code` is set on
 * any non-ok outcome so callers and dashboards can branch on stable strings.
 */
export interface IndexerLagSloResult {
  withinSlo: boolean;
  code?: IndexerLagErrorCode;
  correlationId: string;
  /** Observed lag in seconds, or null when no fresh sample is available. */
  lagSeconds: number | null;
  targetLagSeconds: number;
}

/**
 * Evaluates the indexer lag SLO fail-closed (#1178): a missing, stale, or
 * non-finite sample is treated as a breach (INDEXER_LAG_UNAVAILABLE) rather
 * than silently passing, and a lag above the target yields
 * INDEXER_LAG_SLO_BREACH. Never surfaces raw error objects or connection
 * details. Emits an actionable warn log on breach so the SLO is observable.
 */
export function evaluateIndexerLagSlo(
  sample: IndexerLagSample | null | undefined,
  slo: IndexerLagSlo,
  correlationId: string,
  now: () => number = Date.now,
  logger?: ProbeLogger,
): IndexerLagSloResult {
  const base = {
    correlationId,
    targetLagSeconds: slo.targetLagSeconds,
  };

  const fresh =
    sample != null &&
    Number.isFinite(sample.lagSeconds) &&
    Number.isFinite(sample.observedAtMs) &&
    now() - sample.observedAtMs <= slo.maxStalenessSeconds * 1000;

  if (!fresh) {
    const result: IndexerLagSloResult = {
      ...base,
      withinSlo: false,
      code: "INDEXER_LAG_UNAVAILABLE",
      lagSeconds: null,
    };
    logger?.warn(
      { correlationId, code: result.code, targetLagSeconds: slo.targetLagSeconds },
      "indexer lag SLO unmeasurable",
    );
    return result;
  }

  const lagSeconds = sample.lagSeconds;
  const withinSlo = lagSeconds <= slo.targetLagSeconds;
  const result: IndexerLagSloResult = {
    ...base,
    withinSlo,
    lagSeconds,
  };
  if (!withinSlo) {
    result.code = "INDEXER_LAG_SLO_BREACH";
    logger?.warn(
      {
        correlationId,
        code: result.code,
        lagSeconds,
        targetLagSeconds: slo.targetLagSeconds,
      },
      "indexer lag SLO breached",
    );
  }
  return result;
}

/**
 * Routes exempt from rate limiting. These are ops-internal endpoints that
 * infrastructure scrapes on a fixed short interval and must never be
 * throttled (matching Prometheus/Grafana convention — see docs/metrics.md).
 */
const RATE_LIMIT_EXEMPT_PATHS = new Set(["/health", "/ready", "/metrics"]);

/**
 * Builds the indexer's read-only HTTP surface (GET /markets, /markets/:id,
 * GET /metrics) plus liveness (/health) and readiness (/ready) probes.
 *
 * indexerCorsPlugin is registered before any route so no path is ever
 * reachable without going through the shared origin-allowlist policy
 * (packages/shared/src/cors.ts) first — in NODE_ENV=production an unset
 * CORS_ALLOWED_ORIGINS resolves to a deny-all list rather than an open one
 * (#775), so a misconfigured deploy fails closed instead of silently
 * exposing markets data to any origin.
 *
 * Probe semantics (#1081):
 * - GET /health is a liveness probe: it returns 200 whenever the process is
 *   running and never touches dependencies, so an orchestrator does not
 *   restart a healthy process during a transient DB/Redis/RPC outage.
 * - GET /ready is a readiness probe: it runs the supplied critical-dependency
 *   checks and returns 503 (fail-closed) if any is unavailable, so traffic is
 *   withheld until dependencies recover. Responses carry a correlation id and
 *   stable error codes, and never include connection strings, credentials, or
 *   internal addresses.
 *
 * Metrics endpoint:
 * - GET /metrics returns Prometheus-formatted metrics from the supplied
 *   registry (or a default empty one). It is excluded from rate limiting
 *   matching Prometheus/Grafana convention, and is unauthenticated by
 *   convention — restrict network access at the infra/ingress layer.
 *
 * Rate limiting (#1084, RATE_LIMIT_POLICY.md):
 * - Every external entrypoint is rate limited via an onRequest hook that runs
 *   before route handlers. Policies are declared in RATE_LIMIT_POLICIES; a
 *   path without a policy is denied 

/* … truncated 7874 chars — edit only what you need near the top … */
