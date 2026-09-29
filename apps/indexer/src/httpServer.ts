import fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
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
 * Stable error code for an unrouted path. Deny-by-default: an entrypoint
 * that nobody registered must answer with a stable code and a correlation
 * id, never Fastify's default body (which echoes the raw method/url and so
 * hands an untrusted caller a free route enumeration signal).
 */
export type NotFoundErrorCode = "NOT_FOUND";

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

/** Current epoch milliseconds. Indirection keeps the clock swappable in tests. */
function nowMs(): number {
  return Date.now();
}

/** Longest caller-supplied correlation id we are willing to echo. */
const MAX_CORRELATION_ID_LENGTH = 128;

/**
 * Correlation ids are echoed verbatim into JSON bodies, log lines and the
 * `x-correlation-id` response header, so a caller-supplied value is a
 * log-forging / header-injection vector. Accept only short, printable,
 * space-free ASCII; anything else is replaced with Fastify's generated id
 * so tracing still works but the attacker cannot inject structure.
 */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Resolves the correlation id for a request: echoes `x-correlation-id` when
 * it is well formed, otherwise generates one. Never throws and never returns
 * an unvalidated caller-controlled string.
 */
export function resolveCorrelationId(
  header: string | string[] | undefined,
  fallback: string
): string {
  if (typeof header === "string" && SAFE_CORRELATION_ID.test(header)) {
    return header;
  }
  return fallback;
}

/**
 * Length-safe, constant-time secret comparison.
 *
 * `a === b` on a credential lets an attacker recover the expected value one
 * character at a time by timing the 401. Comparing digests keeps the work
 * independent of the secret length and the position of the first difference.
 */
function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== "string") {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so a length mismatch is not measurably faster
    // than a value mismatch of the same length.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Attach IETF-style quota-visibility headers to a response.
 *
 * Header names follow the IETF RateLimit header fields draft
 * (draft-ietf-httpapi-ratelimit-headers), matching the main API surface
 * (src/api/middleware/rateLimiter.ts) and RATE_LIMIT_POLICY.md:
 *
 *   RateLimit-Limit     — maximum requests allowed in the window
 *   RateLimit-Remaining — requests still available in the current window
 *   RateLimit-Reset     — Unix timestamp (seconds) when the window resets
 *
 * `remaining` is clamped at 0 so a client never sees a negative quota.
 */
function setQuotaHeaders(
  reply: FastifyReply,
  policy: RateLimitPolicy,
  remaining: number,
  now: number = nowMs()
): void {
  reply
    .header("RateLimit-Limit", String(policy.limit))
    .header("RateLimit-Remaining", String(Math.max(0, remaining)))
    .header(
      "RateLimit-Reset",
      String(Math.ceil((now + policy.windowMs) / 1000))
    );
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
 * Minimal counter store surface. Implementations may be in-memory (single
 * process) or Redis-backed (multi-instance). `increment` must be atomic and
 * return the new count for the key within the current window; it must reject
 * on dependency outage so callers can fail closed.
 */
export interface RateLimitStore {
  increment: (key: string, windowMs: number) => Promise<number>;
  /**
   * Optional: evict entries whose window has reset. Implementations that
   * never forget a key (the in-memory default) must implement this, otherwise
   * a long-running process accumulates one entry per client identity ever
   * seen — trivially inducible by rotating source addresses.
   */
  sweep?(now: number): void;
  /** Optional: number of tracked keys, for tests and memory-pressure alerts. */
  readonly size?: number;
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
        buckets.set(key, { count: 1, resetAt: ts + windowMs });
        return 1;
      }
      existing.count += 1;
      return existing.count;
    },
    /** Test/ops hook: drops every window whose quota has already reset. */
    sweep(ts = now()): void {
      for (const [bucketKey, bucket] of buckets) {
        if (ts >= bucket.resetAt) {
          buckets.delete(bucketKey);
        }
      }
    },
    get size(): number {
      return buckets.size;
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

/** The indexer serves no request bodies; anything larger is rejected. */
const BODY_LIMIT_BYTES = 16 * 1024;

/** Longest accepted path parameter (`/markets/:id`). */
const MAX_PARAM_LENGTH = 256;

/** Hard bound on how long a single request may occupy the server. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Bound on how long an idle connection is kept open. */
const CONNECTION_TIMEOUT_MS = 10_000;

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
 * - When INDEXER_REQUIRED_PRINCIPAL / INDEXER_API_KEY are configured the
 *   supplied credential is compared in constant time (#1128). A plain `===`
 *   on a shared secret leaks the expected value one character at a time to
 *   anyone who can time the 401. The denied value is never logged.
 *
 * Hardening (#1128):
 * - The caller-supplied `x-correlation-id` is validated (short, printable,
 *   space-free ASCII) before it is echoed into bodies, logs and the
 *   `x-correlation-id` response header, so it cannot be used to forge log
 *   lines or inject header structure. The resolved id is echoed on every
 *   response, including denials and 404s.
 * - The in-memory rate-limit store evicts windows that have already reset.
 *   Without that, one entry per client identity ever seen is retained for the
 *   lifetime of the process — an unbounded leak trivially inducible by
 *   rotating source addresses.
 * - Unrouted paths answer 404 with the stable NOT_FOUND code and a
 *   correlation id instead of Fastify's default body, which echoes the raw
 *   method/url and is a free route-enumeration signal.
 * - The server bounds body size, path-parameter length, request lifetime and
 *   connection lifetime, and keeps `trustProxy` off so `request.ip` — the
 *   rate-limit identity — cannot be spoofed with X-Forwarded-For.
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
  /** Prometheus registry to serve at GET /metrics. Defaults to a new empty registry. */
  metricsRegistry?: Registry;
}): Promise<FastifyInstance> {
  // The indexer HTTP surface is read-only, so every request is a GET/HEAD
  // with no body. Bounding the body, the header/URL parser and the request
  // lifetime means a hostile client cannot pin a socket or stream an
  // unbounded payload; a parameter this long can never be a real market id.
  const app = fastify({
    logger: false,
    // trustProxy stays off: `request.ip` is the rate-limit identity, and
    // honouring X-Forwarded-For without a trusted proxy in front would let a
    // client mint an unlimited number of identities.
    trustProxy: false,
    bodyLimit: BODY_LIMIT_BYTES,
    maxParamLength: MAX_PARAM_LENGTH,
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
  });
  const readinessChecks = options?.readinessChecks ?? [];
  const logger = options?.logger;
  const rateLimitStore =
    options?.rateLimitStore ?? createInMemoryRateLimitStore();
  const rateLimitPolicies = options?.rateLimitPolicies ?? RATE_LIMIT_POLICIES;
  const metricsRegistry = options?.metricsRegistry;

  await app.register(indexerCorsPlugin);

  // Echo the resolved correlation id on every response (including the ones
  // short-circuited below) so a client can always tie its own id to our logs.
  app.addHook("onRequest", async (request, reply) => {
    const routePath = request.routeOptions?.url ?? request.url.split("?")[0];
    const correlationId = resolveCorrelationId(
      request.headers["x-correlation-id"],
      request.id
    );
    reply.header("x-correlation-id", correlationId);

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
      if (!secretsMatch(principal, requiredPrincipal)) {
        if (logger) {
          // Never log the provided value — it is attacker-controlled.
          logger.warn(
            {
              event: "indexer.authz.denied",
              reason: "principal_mismatch",
              correlationId,
              routePath,
            },
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
      if (!secretsMatch(providedKey, apiKey)) {
        if (logger) {
          logger.warn(
            {
              event: "indexer.authz.denied",
              reason: "api_key_mismatch",
              correlationId,
              routePath,
            },
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
      // Deny-by-default: an entrypoint with no explicit policy is rejected
      // rather than served unlimited. Advertise a zero quota so a client
      // sees the denial is a policy decision, not a transient failure.
      reply
        .header("RateLimit-Limit", "0")
        .header("RateLimit-Remaining", "0")
        .header("RateLimit-Reset", String(Math.ceil(nowMs() / 1000)));
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
          { event: "indexer.ratelimit.unavailable", correlationId, routePath },
          "rate limit store unavailable"
        );
      }
      return reply.code(503).send({
        code: "DEPENDENCY_UNAVAILABLE" satisfies ProbeErrorCode,
        correlationId,
      });
    }

    if (count > policy.limit) {
      if (logger) {
        logger.warn(
          { event: "indexer.ratelimit.exceeded", correlationId, routePath },
          "rate limit exceeded"
        );
      }
      setQuotaHeaders(reply, policy, Math.max(0, policy.limit - count));
      return reply
        .code(429)
        .header("Retry-After", String(Math.ceil(policy.windowMs / 1000)))
        .send({
          code: "RATE_LIMITED" satisfies RateLimitErrorCode,
          correlationId,
        });
    }

    // Advertise the remaining quota on every allowed response so clients
    // can back off proactively instead of discovering the limit as a 429.
    setQuotaHeaders(reply, policy, Math.max(0, policy.limit - count));

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
          {
            event: "indexer.authz.denied",
            reason: "missing_principal",
            correlationId,
            routePath,
          },
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
    const correlationId = resolveCorrelationId(
      request.headers["x-correlation-id"],
      request.id
    );
    if (logger) {
      logger.info({ correlationId, route: "/health" }, "liveness probe ok");
    }
    return reply.code(200).send({
      status: "ok",
      correlationId,
    });
  });

  app.get("/ready", async (request, reply) => {
    const correlationId = resolveCorrelationId(
      request.headers["x-correlation-id"],
      request.id
    );
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

  // Deny-by-default for unrouted paths. Fastify's default 404 body echoes
  // the method and url, which is a free route-enumeration signal and carries
  // no correlation id. Answer with a stable code instead, and apply the same
  // rate limit as every other entrypoint so a scanner cannot hammer it for
  // free.
  app.setNotFoundHandler(async (request, reply) => {
    const correlationId = resolveCorrelationId(
      request.headers["x-correlation-id"],
      request.id
    );
    reply.header("x-correlation-id", correlationId);

    const routePath = request.url.split("?")[0];
    const policy = rateLimitPolicies[routePath];
    if (policy) {
      const principal =
        (request.headers["x-principal"] as string | undefined) ?? undefined;
      const key = rateLimitKey(routePath, principal, request.ip);
      try {
        const count = await rateLimitStore.increment(key, policy.windowMs);
        setQuotaHeaders(reply, policy, Math.max(0, policy.limit - count));
      } catch {
        if (logger) {
          logger.warn(
            {
              event: "indexer.ratelimit.unavailable",
              correlationId,
              routePath,
            },
            "rate limit store unavailable"
          );
        }
        return reply.code(503).send({
          code: "DEPENDENCY_UNAVAILABLE" satisfies ProbeErrorCode,
          correlationId,
        });
      }
    }

    if (logger) {
      logger.warn(
        { event: "indexer.route.not_found", correlationId, routePath },
        "no route matched request"
      );
    }

    return reply.code(404).send({
      code: "NOT_FOUND" satisfies NotFoundErrorCode,
      correlationId,
    });
  });

  await app.register(marketsRoutes);
  return app;
}
