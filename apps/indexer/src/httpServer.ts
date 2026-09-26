import fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { Registry } from "prom-client";
import { indexerCorsPlugin } from "./middleware/cors.js";
import { marketsRoutes } from "./routes/markets.js";

/**
 * Stable error codes for probe and auth responses.  Kept as a closed
 * union so callers and dashboards can branch on exact strings rather
 * than free-form messages.
 */
export type ProbeErrorCode =
  "NOT_READY" | "DEPENDENCY_UNAVAILABLE" | "UNAUTHORIZED";

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
export type MarketErrorCode =
  "UNAUTHORIZED" | "MARKET_NOT_FOUND" | "MARKET_QUERY_FAILED";

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
  // Trade history is the heaviest read: a full page is a 100-row range scan
  // over indexed_trades, so it gets the tightest budget of the data routes.
  "/markets/:id/trades": { limit: 30, windowMs: 60_000 },
};

/**
 * Result of a single rate-limit increment.
 *
 * `resetAtMs` is included alongside the count so the HTTP layer can emit the
 * IETF `RateLimit-*` headers required by RATE_LIMIT_POLICY.md. Keeping the
 * window metadata on the store result (rather than recomputing it in the
 * handler) means a Redis-backed store and the in-memory store report the same
 * reset instant even though only the store knows when the window actually
 * rolled over.
 */
export interface RateLimitCounter {
  /** Request count for this key within the current window, after this request. */
  count: number;
  /** Unix epoch milliseconds at which the current window resets. */
  resetAtMs: number;
}

/**
 * Minimal counter store surface. Implementations may be in-memory (single
 * process) or Redis-backed (multi-instance). `increment` must be atomic and
 * return the new count for the key within the current window; it must reject
 * on dependency outage so callers can fail closed.
 */
export interface RateLimitStore {
  increment: (key: string, windowMs: number) => Promise<RateLimitCounter>;
}

/**
 * In-memory fixed-window counter store. Suitable for single-process
 * deployments and tests; multi-instance deployments should supply a
 * Redis-backed store so limits are shared across replicas.
 */
export function createInMemoryRateLimitStore(
  now: () => number = Date.now
): RateLimitStore {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    async increment(key, windowMs) {
      const ts = now();
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= ts) {
        const resetAt = ts + windowMs;
        buckets.set(key, { count: 1, resetAt });
        return { count: 1, resetAtMs: resetAt };
      }
      existing.count += 1;
      return { count: existing.count, resetAtMs: existing.resetAt };
    },
  };
}

/**
 * Attach the IETF rate-limit headers to a reply.
 *
 * RATE_LIMIT_POLICY.md requires every response to carry
 * `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`, and a `429`
 * to additionally carry `Retry-After`. Without them a client cannot tell how
 * long to back off and is reduced to blind retry loops, which is exactly the
 * load the limiter exists to shed.
 *
 * - `RateLimit-Limit`     — the tier's maximum requests per window
 * - `RateLimit-Remaining` — requests left in the current window (never negative)
 * - `RateLimit-Reset`     — Unix timestamp in **seconds** when the window resets
 * - `Retry-After`         — seconds until reset, on 429 only (HTTP-date form
 *                           is also permitted, but seconds is unambiguous)
 */
export function setRateLimitHeaders(
  reply: FastifyReply,
  policy: RateLimitPolicy,
  counter: RateLimitCounter,
  now: number = Date.now()
): void {
  const resetSeconds = Math.ceil(counter.resetAtMs / 1000);
  const retryAfterSeconds = Math.max(
    0,
    Math.ceil((counter.resetAtMs - now) / 1000)
  );

  reply
    .header("RateLimit-Limit", String(policy.limit))
    .header(
      "RateLimit-Remaining",
      String(Math.max(0, policy.limit - counter.count))
    )
    .header("RateLimit-Reset", String(resetSeconds));

  if (retryAfterSeconds > 0) {
    reply.header("Retry-After", String(retryAfterSeconds));
  }
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
  remoteAddress: string | undefined
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
  logger?: ProbeLogger
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
    })
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
 *   path without a policy is denied with RATE_LIMITED (deny-by-default) so a
 *   new route cannot ship unlimited.
 * - The client key prefers the authenticated principal over the socket
 *   address so untrusted clients cannot bypass the policy by rotating IPs.
 * - If the counter store (e.g. Redis) is unavailable, the hook fails closed
 *   with 503 DEPENDENCY_UNAVAILABLE rather than allowing the request through.
 * - Rejections return a stable error code and the request correlation id, and
 *   never leak credentials or internal addresses.
 * - Ops-internal endpoints (/health, /ready, /metrics) are exempt from rate
 *   limiting so infrastructure scrapers are never throttled.
 *
 * Authz (#1097):
 * - Every external data route (/markets, /markets/:id) requires a valid
 *   x-principal header.  Requests without a principal are rejected with 401
 *   UNAUTHORIZED so untrusted clients cannot bypass the rate-limit policy.
 * - Probe endpoints (/health, /ready) are exempt from authz so that
 *   kubelet and load balancers can reach them without credentials.
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
  /**
   * Clock used to compute `Retry-After`. Injectable so tests can assert an
   * exact backoff; defaults to the wall clock. Keep this consistent with the
   * clock the supplied `rateLimitStore` uses, otherwise the two disagree about
   * when the window opened.
   */
  now?: () => number;
  /** Prometheus registry to serve at GET /metrics. Defaults to a new empty registry. */
  metricsRegistry?: Registry;
}): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  const readinessChecks = options?.readinessChecks ?? [];
  const logger = options?.logger;
  const rateLimitStore =
    options?.rateLimitStore ?? createInMemoryRateLimitStore();
  const rateLimitPolicies = options?.rateLimitPolicies ?? RATE_LIMIT_POLICIES;
  const nowFn = options?.now ?? Date.now;
  const metricsRegistry = options?.metricsRegistry;

  await app.register(indexerCorsPlugin);

  app.addHook("onRequest", async (request, reply) => {
    const routePath = request.routeOptions?.url ?? request.url.split("?")[0];
    const correlationId =
      (request.headers["x-correlation-id"] as string | undefined) ?? request.id;

    // Exempt ops-internal endpoints from rate limiting
    if (RATE_LIMIT_EXEMPT_PATHS.has(routePath)) {
      return;
    }

    // Authz: reject untrusted clients so they cannot bypass CORS policy.
    // When INDEXER_REQUIRED_PRINCIPAL is configured the x-principal header
    // must match; when INDEXER_API_KEY is configured the x-api-key header
    // must match.  If neither is configured the hook still passes (a
    // startup warning is emitted by main.ts) but the surface is gated
    // behind INDEXER_HTTP_ENABLED so it is not accidentally exposed.
    const requiredPrincipal = process.env.INDEXER_REQUIRED_PRINCIPAL;
    const apiKey = process.env.INDEXER_API_KEY;

    if (requiredPrincipal) {
      const principal =
        (request.headers["x-principal"] as string | undefined) ?? undefined;
      if (principal !== requiredPrincipal) {
        if (logger) {
          logger.warn(
            { correlationId, routePath },
            "indexer authz rejected: principal mismatch"
          );
        }
        return reply.code(401).send({
          error: "Unauthorized",
          code: "UNAUTHORIZED" satisfies MarketErrorCode,
          correlationId,
        });
      }
    }

    if (apiKey) {
      const providedKey =
        (request.headers["x-api-key"] as string | undefined) ?? undefined;
      if (providedKey !== apiKey) {
        if (logger) {
          logger.warn(
            { correlationId, routePath },
            "indexer authz rejected: invalid API key"
          );
        }
        return reply.code(401).send({
          error: "Unauthorized",
          code: "UNAUTHORIZED" satisfies MarketErrorCode,
          correlationId,
        });
      }
    }

    const policy = rateLimitPolicies[routePath];

    if (!policy) {
      // Deny-by-default: a route with no policy is never served. There is no
      // meaningful quota to report, so no RateLimit-* headers are emitted
      // beyond the implicit zero remaining.
      return reply
        .code(429)
        .header("RateLimit-Limit", "0")
        .header("RateLimit-Remaining", "0")
        .send({
          code: "RATE_LIMITED" satisfies RateLimitErrorCode,
          message: "No rate-limit policy is configured for this route",
          correlationId,
        });
    }

    const principal =
      (request.headers["x-principal"] as string | undefined) ?? undefined;
    const key = rateLimitKey(routePath, principal, request.ip);

    let counter: RateLimitCounter;
    try {
      counter = await rateLimitStore.increment(key, policy.windowMs);
    } catch {
      if (logger) {
        logger.warn(
          { correlationId, routePath },
          "rate limit store unavailable"
        );
      }
      // Fail-closed on a counter-store outage. Remaining is reported as 0 so
      // a client that trusts the header stops hammering a broken limiter.
      return reply
        .code(503)
        .header("RateLimit-Limit", String(policy.limit))
        .header("RateLimit-Remaining", "0")
        .send({
          code: "DEPENDENCY_UNAVAILABLE" satisfies ProbeErrorCode,
          correlationId,
        });
    }

    // Quota headers are attached before the limit check so they are present on
    // the 200 path as well as the 429 path (RATE_LIMIT_POLICY.md: "All
    // responses include ...").
    setRateLimitHeaders(reply, policy, counter, nowFn());

    if (counter.count > policy.limit) {
      if (logger) {
        logger.warn({ correlationId, routePath }, "rate limit exceeded");
      }
      // Retry-After (set by setRateLimitHeaders) tells the client exactly how
      // long to wait instead of guessing and retry-looping.
      return reply.code(429).send({
        code: "RATE_LIMITED" satisfies RateLimitErrorCode,
        correlationId,
      });
    }

    // Authz: every external entrypoint (market data) requires an
    // authenticated principal.  Probes (/health, /ready) are exempt
    // so that kubelet and load balancers can reach them without
    // credentials.  A missing principal on a money-path or data
    // route is rejected with 401 rather than served — deny-by-default.
    // CORS preflight (OPTIONS) is exempt so that browser preflight
    // requests are not blocked by authz before the CORS plugin can
    // evaluate the origin allowlist.
    const isProbe = routePath === "/health" || routePath === "/ready";
    const isPreflight = request.method === "OPTIONS";
    if (!isProbe && !isPreflight && !principal) {
      if (logger) {
        logger.warn(
          { correlationId, routePath },
          "unauthorized: missing x-principal"
        );
      }
      return reply.code(401).send({
        code: "UNAUTHORIZED" satisfies ProbeErrorCode,
        correlationId,
      });
    }
  });

  app.get("/health", async (request, reply) => {
    const correlationId =
      (request.headers["x-correlation-id"] as string | undefined) ?? request.id;
    if (logger) {
      logger.info({ correlationId, route: "/health" }, "liveness probe ok");
    }
    return reply.code(200).send({
      status: "ok",
      correlationId,
    });
  });

  app.get("/ready", async (request, reply) => {
    const correlationId =
      (request.headers["x-correlation-id"] as string | undefined) ?? request.id;
    const result = await runReadinessChecks(
      readinessChecks,
      correlationId,
      logger
    );
    if (logger) {
      const logLevel = result.ready ? "info" : "warn";
      logger[logLevel](
        { correlationId, ready: result.ready, checks: result.checks },
        result.ready ? "readiness probe ok" : "readiness probe failed"
      );
    }
    return reply.code(result.ready ? 200 : 503).send(result);
  });

  // GET /metrics — Prometheus scrape endpoint (#745, #1096)
  // Excluded from rate limiting (see RATE_LIMIT_EXEMPT_PATHS above).
  // Unauthenticated by convention — restrict network access at the
  // infra/ingress layer (e.g. only allow the internal Prometheus scraper).
  if (metricsRegistry) {
    app.get("/metrics", async (_request, reply) => {
      reply.header("Content-Type", metricsRegistry.contentType);
      return metricsRegistry.metrics();
    });
  } else {
    // When no registry is supplied, return an empty metrics response so the
    // endpoint is always defined and scrapers never get 404/429.
    app.get("/metrics", async (_request, reply) => {
      reply.header("Content-Type", "text/plain; charset=utf-8; version=0.0.4");
      return "# No metrics registry configured\n";
    });
  }

  await app.register(marketsRoutes);
  return app;
}
