import fastify, { type FastifyInstance } from "fastify";
import type { Registry } from "prom-client";
import { indexerCorsPlugin } from "./middleware/cors.js";
import { marketsRoutes } from "./routes/markets.js";
import type { DependencyProbe } from "./startupHealth.js";

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
 * Stable error codes for body-size-limit responses. Kept as a closed union
 * so clients and dashboards can branch on exact strings rather than
 * free-form messages (see BODY_LIMIT_POLICY.md).
 */
export type BodyLimitErrorCode = "PAYLOAD_TOO_LARGE";

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
 * Body-size-limit policy for a single external entrypoint. `maxBytes` is the
 * maximum accepted request body size in bytes. The policy is deny-by-default:
 * any entrypoint without an explicit policy is rejected rather than served
 * with an unbounded body (BODY_LIMIT_POLICY.md).
 */
export interface BodyLimitPolicy {
  /** Maximum accepted request body size in bytes. Must be > 0. */
  maxBytes: number;
}

/**
 * Per-entrypoint body-size-limit policies keyed by route path. Only paths
 * listed here are served; everything else fails closed with
 * PAYLOAD_TOO_LARGE so a new route cannot silently ship without a limit.
 *
 * The indexer HTTP surface is read-only (GET /markets, /markets/:id,
 * /health, /ready, /metrics), so bodies are not expected at all; the limit
 * is intentionally small to reject adversarial oversized payloads early.
 */
export const BODY_LIMIT_POLICIES: Record<string, BodyLimitPolicy> = {
  "/health": { maxBytes: 1_024 },
  "/ready": { maxBytes: 1_024 },
  "/metrics": { maxBytes: 1_024 },
  "/markets": { maxBytes: 8_192 },
  "/markets/:id": { maxBytes: 8_192 },
};

/**
 * Default body-size limit applied when a path has no explicit policy. Kept
 * small so an unlisted route fails closed rather than accepting an unbounded
 * body.
 */
export const DEFAULT_BODY_LIMIT_BYTES = 1_024;

/**
 * Resolves the body-size limit for a route path, falling back to the
 * deny-by-default limit when no explicit policy is declared. Never returns
 * an unbounded value.
 */
export function resolveBodyLimitBytes(
  routePath: string,
  policies: Record<string, BodyLimitPolicy> = BODY_LIMIT_POLICIES,
): number {
  const policy = policies[routePath];
  if (policy && Number.isFinite(policy.maxBytes) && policy.maxBytes > 0) {
    return policy.maxBytes;
  }
  return DEFAULT_BODY_LIMIT_BYTES;
}

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
    result.code = "NOT_READY";
    logger?.warn(
      { correlationId, checks: results },
      "indexer readiness probe failed",
    );
  }
  return result;
}

/**
 * Adapts a `DependencyProbe` (the same type used by `main.ts` and produced by
 * the probe factory in `startupHealth.ts`) into a `ReadinessCheck` so the
 * readiness route re-runs the exact startup dependency checks rather than
 * duplicating check logic.
 */
export function readinessCheckFromProbe(probe: DependencyProbe): ReadinessCheck {
  return {
    name: probe.name,
    check: async () => {
      await probe.check();
    },
  };
}

/**
 * Options for the readiness route. `probes` are the same dependency probes
 * used at startup; they are re-evaluated on every request so a dependency
 * that degrades after boot is reflected in the probe result.
 */
export interface ReadinessRouteOptions {
  probes: DependencyProbe[];
  logger?: ProbeLogger;
  /** Correlation id generator; defaults to a random UUID. */
  generateCorrelationId?: () => string;
}

/**
 * Registers the readiness route on the given Fastify instance. Returns 200
 * with `{ ready: true, correlationId, checks }` when every probe resolves and
 * 503 with `{ ready: false, code: "NOT_READY", correlationId, checks }` when
 * any probe rejects. The body contains only dependency names and coarse
 * statuses — never connection strings, hostnames, or credentials.
 */
export function registerReadinessRoute(
  app: FastifyInstance,
  options: ReadinessRouteOptions,
): void {
  const generateCorrelationId =
    options.generateCorrelationId ?? (() => globalThis.crypto.randomUUID());

  app.get("/ready", async (request, reply) => {
    const correlationId = generateCorrelationId();
    const checks = options.probes.map(readinessCheckFromProbe);
    const result = await runReadinessChecks(
      checks,
      correlationId,
      options.logger,
    );
    const status = result.ready ? 200 : 503;
    return reply.code(status).send(result);
  });
}

/**
 * Builds the indexer HTTP server. When `readiness` options are supplied the
 * `/ready` route is registered so orchestrators can distinguish a live
 * process from one whose ingestion dependencies are usable.
 */
export function buildIndexerHttpServer(options: {
  registry?: Registry;
  readiness?: ReadinessRouteOptions;
} = {}): FastifyInstance {
  const app = fastify({ logger: false });
  app.register(indexerCorsPlugin);
  app.register(marketsRoutes);
  if (options.readiness) {
    registerReadinessRoute(app, options.readiness);
  }
  return app;
}
