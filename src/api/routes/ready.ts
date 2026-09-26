/**
 * GET /v1/ready — Readiness endpoint
 *
 * Checks that all CRITICAL downstream dependencies are healthy before
 * reporting the service as ready to serve traffic.
 *
 * Liveness vs Readiness:
 *   - Liveness  (GET /v1/health): the process is alive and the HTTP server
 *     is responding. No hard dependency checks — a healthy status here
 *     means Kubernetes should NOT restart the pod.
 *   - Readiness (GET /v1/ready): the process can serve valid data. Returns
 *     503 when any CRITICAL dependency is unavailable so the load balancer
 *     stops routing traffic to this instance while it recovers.
 *
 * Dependency criticality tiers:
 *   CRITICAL  — DB, index freshness: must be ok for 200.
 *   WARNING   — Redis: blips are expected; a Redis outage must NOT kill pods
 *               (the service degrades gracefully — rate-limit windows reset,
 *               order-book cache misses fall through to Postgres). Redis
 *               status is surfaced in the response body for observability
 *               but does NOT drive the HTTP status code.
 *
 * Response shape:
 *   {
 *     "ready": boolean,
 *     "code": "OK" | "DEPENDENCY_UNAVAILABLE" | "DEPENDENCY_TIMEOUT",
 *     "correlationId": string,
 *     "dependencies": {
 *       "database":       { "status": "ok" | "error", "error"?: string },
 *       "redis":          { "status": "ok" | "error", "error"?: string },
 *       "indexFreshness": { "status": "ok" | "stale" | "error", "error"?: string }
 *     }
 *   }
 *
 * HTTP status:
 *   200 — all CRITICAL dependencies healthy (Redis may be degraded)
 *   503 — one or more CRITICAL dependencies failed
 *
 * SECURITY (#1141 — health probes must not leak secrets):
 *   Raw dependency errors are NEVER copied into the response. Driver errors
 *   can embed connection strings, credentials, hostnames, or internal
 *   addresses (e.g. "Can't reach database server at `db:5432`"). The
 *   underlying error (with credentials redacted) is logged server-side
 *   keyed by the correlation id; the response only carries a coarse, fixed
 *   reason that is safe to expose to any unauthenticated caller. Each check
 *   is bounded by READY_CHECK_TIMEOUT_MS (default 2s) so a hung dependency
 *   cannot hang the probe — a check that exceeds its deadline fails closed
 *   and is reported as DEPENDENCY_TIMEOUT.
 *
 * @module src/api/routes/ready
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

/** Maximum age (ms) before the index is considered stale. Default: 5 minutes. */
const thresholdEnv = process.env.INDEX_STALENESS_THRESHOLD_MS;
export const INDEX_STALENESS_THRESHOLD_MS = thresholdEnv
  ? parseInt(thresholdEnv, 10)
  : 300_000;

/** Per-check deadline (ms). Default: 2 seconds. */
export const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

/** Stable top-level error codes (README.md "Readiness response contract"). */
export type ReadyCode = "OK" | "DEPENDENCY_UNAVAILABLE" | "DEPENDENCY_TIMEOUT";

/**
 * Coarse failure reasons returned to clients. These are fixed strings —
 * never derived from the underlying error — so no connection detail can
 * reach an unauthenticated probe response.
 */
const SAFE_FAILURE = {
  database: "Database check failed",
  redis: "Redis check failed",
  indexFreshness: "Index freshness check failed",
  timeout: "Dependency check timed out",
} as const;

/**
 * Redact credentials embedded in error text before it reaches structured
 * logs (connection-string userinfo, password/token key-value pairs).
 */
export function redactForLog(message: string): string {
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1***:***@")
    .replace(
      /((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)\S+/gi,
      "$1***"
    );
}

export type DependencyStatus = "ok" | "error" | "stale";

export interface DependencyResult {
  status: DependencyStatus;
  error?: string;
}

export interface ReadyResponse {
  ready: boolean;
  code: ReadyCode;
  correlationId: string;
  dependencies: {
    database: DependencyResult;
    /** Redis is a WARNING-tier dependency — degraded Redis does NOT block readiness. */
    redis: DependencyResult;
    indexFreshness: DependencyResult;
  };
}

/**
 * Dependency checkers injected into the route so they can be replaced
 * in tests without touching real infrastructure.
 */
export interface ReadyDeps {
  /** Throws if the database is unreachable. */
  checkDatabase(): Promise<void>;
  /**
   * Throws if the Redis instance is unreachable.
   * NOTE: Redis failures set redis.status = "error" in the response but do
   * NOT change the HTTP status code — Redis is a WARNING-tier dependency.
   */
  checkRedis(): Promise<void>;
  /**
   * Returns the timestamp (ms since epoch) of the most recent indexed
   * event, or null if no events have been indexed yet.
   */
  getLastIndexedAt(): Promise<number | null>;
  /** Current time in ms since epoch. Defaults to Date.now(). */
  now?(): number;
}

/**
 * Raised when a dependency check exceeds its deadline.
 */
class CheckTimeoutError extends Error {
  constructor() {
    super("dependency check exceeded its deadline");
    this.name = "CheckTimeoutError";
  }
}

/** Resolves the per-check deadline from READY_CHECK_TIMEOUT_MS (default 2000). */
export function checkTimeoutMs(): number {
  return Number(process.env.READY_CHECK_TIMEOUT_MS) || DEFAULT_CHECK_TIMEOUT_MS;
}

/**
 * Races a dependency check against its deadline so a hung DB/Redis driver
 * cannot hang the probe indefinitely.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeoutError()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolves the correlation id: x-correlation-id header, else the request id. */
function correlationId(request: FastifyRequest): string {
  const header = request.headers["x-correlation-id"];
  return (typeof header === "string" && header) || request.id;
}

/** Names of the checks run by this probe. */
type CheckLabel = "database" | "redis" | "indexFreshness";

/**
 * Runs one dependency check under the deadline and converts any failure
 * (throw or timeout) into a coarse, secret-free result. The raw error
 * never leaves this function — it is written to structured logs (with
 * credentials redacted) keyed by dependency name and correlation id.
 */
async function runCheck(
  label: CheckLabel,
  timeoutMs: number,
  request: FastifyRequest,
  cid: string,
  check: () => Promise<DependencyResult>
): Promise<DependencyResult> {
  try {
    return await withTimeout(check(), timeoutMs);
  } catch (err) {
    const timedOut = err instanceof CheckTimeoutError;
    const raw = err instanceof Error ? err.message : String(err);
    request.log.warn(
      {
        correlationId: cid,
        dependency: label,
        status: "error",
        timedOut,
        err: redactForLog(raw),
      },
      "readiness check failed"
    );
    return {
      status: "error",
      error: timedOut ? SAFE_FAILURE.timeout : SAFE_FAILURE[label],
    };
  }
}

/**
 * Build the readiness check handler with the given dependency checkers.
 * Register via server.register(readyRoute(deps), { prefix: "/v1" }).
 */
export function readyRoute(deps: ReadyDeps) {
  return async function (fastify: FastifyInstance): Promise<void> {
    fastify.get("/ready", async (request, reply) => {
      const now = deps.now ? deps.now() : Date.now();
      const cid = correlationId(request);
      const timeoutMs = checkTimeoutMs();

      const [dbResult, redisResult, indexResult] = await Promise.all([
        runCheck("database", timeoutMs, request, cid, () => checkDb(deps)),
        runCheck("redis", timeoutMs, request, cid, () => checkRedis(deps)),
        runCheck("indexFreshness", timeoutMs, request, cid, () =>
          checkIndexFreshness(deps, now)
        ),
      ]);

      // CRITICAL tier: DB and index freshness determine readiness.
      // Redis is WARNING-only — blips must not remove the pod from rotation.
      const ready = dbResult.status === "ok" && indexResult.status === "ok";

      const results = [dbResult, redisResult, indexResult];
      const timedOut = results.some((r) => r.error === SAFE_FAILURE.timeout);
      const code: ReadyCode = ready
        ? "OK"
        : timedOut
          ? "DEPENDENCY_TIMEOUT"
          : "DEPENDENCY_UNAVAILABLE";

      const body: ReadyResponse = {
        ready,
        code,
        correlationId: cid,
        dependencies: {
          database: dbResult,
          redis: redisResult,
          indexFreshness: indexResult,
        },
      };

      reply
        .header("x-correlation-id", cid)
        .status(ready ? 200 : 503)
        .send(body);
    });
  };
}

async function checkDb(deps: ReadyDeps): Promise<DependencyResult> {
  // Errors propagate to runCheck, which redacts/logs and maps them to a
  // coarse, secret-free reason — never the raw driver message.
  await deps.checkDatabase();
  return { status: "ok" };
}

async function checkRedis(deps: ReadyDeps): Promise<DependencyResult> {
  await deps.checkRedis();
  return { status: "ok" };
}

async function checkIndexFreshness(
  deps: ReadyDeps,
  now: number
): Promise<DependencyResult> {
  // Throws propagate to runCheck, which redacts/logs and maps them to a
  // coarse, secret-free reason — raw query errors are never echoed.
  const lastIndexedAt = await deps.getLastIndexedAt();

  if (lastIndexedAt === null) {
    // No events indexed yet — treat as stale
    return { status: "stale", error: "No indexed events found" };
  }

  const ageMs = now - lastIndexedAt;
  if (ageMs > INDEX_STALENESS_THRESHOLD_MS) {
    // Computed from timestamps only — safe to expose.
    return {
      status: "stale",
      error: `Index is ${Math.floor(ageMs / 1000)}s old (threshold: ${INDEX_STALENESS_THRESHOLD_MS / 1000}s)`,
    };
  }

  return { status: "ok" };
}
