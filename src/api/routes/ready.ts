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
 *     "dependencies": {
 *       "database":       { "status": "ok" | "error" | "stale", "code"?: string, "error"?: string },
 *       "redis":          { "status": "ok" | "error" | "stale", "code"?: string, "error"?: string },
 *       "indexFreshness": { "status": "ok" | "error" | "stale", "code"?: string, "error"?: string }
 *     }
 *   }
 *
 * No-secret invariant (#1141): this route is unauthenticated, so every
 * `error` string is passed through `sanitizeProbeMessage` and every failure
 * carries a stable `code`. A raw driver message would otherwise publish
 * credentials and internal topology (e.g. Prisma embeds the full
 * `postgres://user:pass@host:5432/db` DSN). The unsanitized error is written
 * to the request log only.
 *
 * HTTP status:
 *   200 — all CRITICAL dependencies healthy (Redis may be degraded)
 *   503 — one or more CRITICAL dependencies failed
 *
 * @module src/api/routes/ready
 */

import type { FastifyInstance } from "fastify";
import {
  PROBE_ERROR_CODES,
  classifyProbeError,
  sanitizeProbeMessage,
} from "../../../packages/shared/src/probeErrors.js";

/** Maximum age (ms) before the index is considered stale. Default: 5 minutes. */
const thresholdEnv = process.env.INDEX_STALENESS_THRESHOLD_MS;
export const INDEX_STALENESS_THRESHOLD_MS = thresholdEnv
  ? parseInt(thresholdEnv, 10)
  : 300_000;

export type DependencyStatus = "ok" | "error" | "stale";

export interface DependencyResult {
  status: DependencyStatus;
  /**
   * Secret-free failure summary. `/v1/ready` is unauthenticated, so this is
   * always passed through {@link sanitizeProbeMessage}: a driver message such
   * as `Can't reach database server at postgres://user:pass@host:5432/db`
   * would otherwise publish credentials and internal topology. The raw error
   * remains available server-side through the request log.
   */
  error?: string;
  /** Stable, secret-free classification for dashboards and alerts. */
  code?: string;
}

export interface ReadyResponse {
  ready: boolean;
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
 * Build the readiness check handler with the given dependency checkers.
 * Register via server.register(readyRoute(deps), { prefix: "/v1" }).
 */
export function readyRoute(deps: ReadyDeps) {
  return async function (fastify: FastifyInstance): Promise<void> {
    fastify.get("/ready", async (request, reply) => {
      const now = deps.now ? deps.now() : Date.now();

      const [dbResult, redisResult, indexResult] = await Promise.all([
        checkDb(deps, request),
        checkRedis(deps, request),
        checkIndexFreshness(deps, now, request),
      ]);

      // CRITICAL tier: DB and index freshness determine readiness.
      // Redis is WARNING-only — blips must not remove the pod from rotation.
      const ready = dbResult.status === "ok" && indexResult.status === "ok";

      const body: ReadyResponse = {
        ready,
        dependencies: {
          database: dbResult,
          redis: redisResult,
          indexFreshness: indexResult,
        },
      };

      if (!ready) {
        // Server-side log keeps the correlation id and dependency statuses so
        // an on-call engineer can trace a failing probe. The response body
        // itself is sanitized (see `sanitizeProbeMessage`) and never carries
        // credentials or internal addresses.
        request.log.warn(
          {
            ready,
            database: dbResult.status,
            redis: redisResult.status,
            indexFreshness: indexResult.status,
          },
          "Readiness check failed"
        );
      }

      reply.status(ready ? 200 : 503).send(body);
    });
  };
}

/**
 * Minimal logger surface used for server-side probe logging. Kept narrow so
 * the readiness route does not depend on a concrete logging implementation
 * and so the unsanitized error is guaranteed to be written to logs only.
 */
interface ProbeRequest {
  log: { warn: (fields: Record<string, unknown>, msg: string) => void };
}

/**
 * Record a failed dependency check.
 *
 * `error` is the sanitized summary published in the response; `code` is the
 * stable classification. The unsanitized error is written to the request log
 * only — never to the reply, which is reachable without authentication.
 */
function failure(
  err: unknown,
  request: ProbeRequest,
  dependency: string
): DependencyResult {
  const code = classifyProbeError(err);
  request.log.warn(
    {
      dependency,
      code,
      error: err instanceof Error ? err.message : String(err),
    },
    "Readiness dependency check failed"
  );
  return {
    status: "error",
    code,
    error: sanitizeProbeMessage(err),
  };
}

async function checkDb(
  deps: ReadyDeps,
  request: ProbeRequest
): Promise<DependencyResult> {
  try {
    await deps.checkDatabase();
    return { status: "ok" };
  } catch (err) {
    return failure(err, request, "database");
  }
}

async function checkRedis(
  deps: ReadyDeps,
  request: ProbeRequest
): Promise<DependencyResult> {
  try {
    await deps.checkRedis();
    return { status: "ok" };
  } catch (err) {
    return failure(err, request, "redis");
  }
}

async function checkIndexFreshness(
  deps: ReadyDeps,
  now: number,
  request: ProbeRequest
): Promise<DependencyResult> {
  try {
    const lastIndexedAt = await deps.getLastIndexedAt();

    if (lastIndexedAt === null) {
      // No events indexed yet — treat as stale
      return {
        status: "stale",
        code: PROBE_ERROR_CODES.NO_DATA,
        error: "No indexed events found",
      };
    }

    const ageMs = now - lastIndexedAt;
    if (ageMs > INDEX_STALENESS_THRESHOLD_MS) {
      return {
        status: "stale",
        code: PROBE_ERROR_CODES.STALE,
        // Only the age and threshold are published — both are configuration,
        // not secrets.
        error: `Index is ${Math.floor(ageMs / 1000)}s old (threshold: ${INDEX_STALENESS_THRESHOLD_MS / 1000}s)`,
      };
    }

    return { status: "ok" };
  } catch (err) {
    return failure(err, request, "indexFreshness");
  }
}
