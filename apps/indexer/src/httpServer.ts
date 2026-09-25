import fastify, { type FastifyInstance } from "fastify";
import { indexerCorsPlugin } from "./middleware/cors.js";
import { marketsRoutes } from "./routes/markets.js";

/**
 * Stable error codes for probe responses. Kept as a closed union so callers
 * and dashboards can rely on exact strings rather than free-form messages.
 */
export type ProbeErrorCode =
  | "NOT_READY"
  | "DEPENDENCY_UNAVAILABLE";

/**
 * Stable error codes for rate-limit responses. Kept as a closed union so
 * clients and dashboards can branch on exact strings rather than free-form
 * messages (see RATE_LIMIT_POLICY.md).
 */
export type RateLimitErrorCode = "RATE_LIMITED";

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
 */
export const RATE_LIMIT_POLICIES: Record<string, RateLimitPolicy> = {
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
 * Builds the indexer's read-only HTTP surface (GET /markets, /markets/:id)
 * plus liveness (/health) and readiness (/ready) probes.
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
 * Rate limiting (#1084, RATE_LIMIT_POLICY.md):
 * - Every external entrypoint is rate limited via an onRequest hook that runs
 *   before route handlers. Policies are declared in RATE_LIMIT_POLICIES; a
 *   path without a policy is denied with RATE_LIMITED (deny-by-default) so a
 *   new route cannot ship unlimited.
 * - The client key prefers the authenticated principal over the socket
 *   address so untrusted clients cannot bypass the policy by rotating IPs.
 * - If the counter store (e.g. Redis) is unavailable, the hook fails closed
 *   with 503 DEPENDENCY_UNAVAILABLE rather than allowing the request through.
 * - Rejections return a stable error code and the request correlation id, and
 *   never leak credentials or internal addresses.
 *
 * Not started automatically: apps/indexer/src/main.ts only calls this when
 * INDEXER_HTTP_ENABLED=true, so the indexer's default off-chain
 * event-ingestion role stays HTTP-free unless an operator explicitly opts
 * in — see docs/docker-compose.md and docs/architecture.md.
 */
export async function buildIndexerHttpServer(options?: {
  readinessChecks?: ReadinessCheck[];
  logger?: ProbeLogger;
  rateLimitStore?: RateLimitStore;
  rateLimitPolicies?: Record<string, RateLimitPolicy>;
}): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  const readinessChecks = options?.readinessChecks ?? [];
  const logger = options?.logger;
  const rateLimitStore =
    options?.rateLimitStore ?? createInMemoryRateLimitStore();
  const rateLimitPolicies = options?.rateLimitPolicies ?? RATE_LIMIT_POLICIES;

  await app.register(indexerCorsPlugin);

  app.addHook("onRequest", async (request, reply) => {
    const routePath = request.routeOptions?.url ?? request.url.split("?")[0];
    const policy = rateLimitPolicies[routePath];
    const correlationId =
      (request.headers["x-correlation-id"] as string | undefined) ??
      request.id;

    if (!policy) {
      return reply.code(429).send({
        code: "RATE_LIMITED" satisfies RateLimitErrorCode,
        correlationId,
      });
    }

    const principal =
      (request.headers["x-principal"] as string | undefined) ?? undefined;
    const key = rateLimitKey(routePath, principal, request.ip);

    let count: number;
    try {
      count = await rateLimitStore.increment(key, policy.windowMs);
    } catch {
      if (logger) {
        logger.warn(
          { correlationId, routePath },
          "rate limit store unavailable",
        );
      }
      return reply.code(503).send({
        code: "DEPENDENCY_UNAVAILABLE" satisfies ProbeErrorCode,
        correlationId,
      });
    }

    if (count > policy.limit) {
      if (logger) {
        logger.warn({ correlationId, routePath }, "rate limit exceeded");
      }
      return reply.code(429).send({
        code: "RATE_LIMITED" satisfies RateLimitErrorCode,
        correlationId,
      });
    }
  });

  app.get("/health", async (_request, reply) => {
    return reply.code(200).send({ status: "ok" });
  });

  app.get("/ready", async (request, reply) => {
    const correlationId =
      (request.headers["x-correlation-id"] as string | undefined) ??
      request.id;
    const result = await runReadinessChecks(
      readinessChecks,
      correlationId,
      logger,
    );
    return reply.code(result.ready ? 200 : 503).send(result);
  });

  await app.register(marketsRoutes);
  return app;
}
