/**
 * GET /v1/ready — Readiness endpoint
 *
 * Checks that all critical downstream dependencies are healthy before
 * reporting the service as ready to serve traffic.
 *
 * Liveness vs Readiness:
 *   - Liveness  (GET /v1/health): the process is alive and the HTTP server
 *     is responding. No dependency checks.
 *   - Readiness (GET /v1/ready):  the process can serve valid data. Fails
 *     when a critical dependency (DB, index freshness) is unavailable.
 *
 * Response shape:
 *   {
 *     "ready": boolean,
 *     "dependencies": {
 *       "database": { "status": "ok" | "error", "error"?: string },
 *       "indexFreshness": { "status": "ok" | "stale" | "error", "error"?: string }
 *     }
 *   }
 *
 * HTTP status:
 *   200 — all critical dependencies healthy
 *   503 — one or more critical dependencies failed
 *
 * @module src/api/routes/ready
 */

import type { FastifyInstance } from "fastify";

/** Maximum age (ms) before the index is considered stale. Default: 5 minutes. */
export const INDEX_STALENESS_THRESHOLD_MS = 5 * 60 * 1000;

export type DependencyStatus = "ok" | "error" | "stale";

export interface DependencyResult {
  status: DependencyStatus;
  error?: string;
}

export interface ReadyResponse {
  ready: boolean;
  dependencies: {
    database: DependencyResult;
    indexFreshness: DependencyResult;
  };
}

/**
 * Dependency checkers injected into the route so they can be replaced
 * in tests without touching real infrastructure.
 */
export interface ReadyDeps {
  /** Returns true if the database is reachable. Throws on failure. */
  checkDatabase(): Promise<void>;
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
    fastify.get("/ready", async (_request, reply) => {
      const now = deps.now ? deps.now() : Date.now();

      const [dbResult, indexResult] = await Promise.all([
        checkDb(deps),
        checkIndexFreshness(deps, now),
      ]);

      const ready = dbResult.status === "ok" && indexResult.status === "ok";

      const body: ReadyResponse = {
        ready,
        dependencies: {
          database: dbResult,
          indexFreshness: indexResult,
        },
      };

      reply.status(ready ? 200 : 503).send(body);
    });
  };
}

async function checkDb(deps: ReadyDeps): Promise<DependencyResult> {
  try {
    await deps.checkDatabase();
    return { status: "ok" };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkIndexFreshness(
  deps: ReadyDeps,
  now: number
): Promise<DependencyResult> {
  try {
    const lastIndexedAt = await deps.getLastIndexedAt();

    if (lastIndexedAt === null) {
      // No events indexed yet — treat as stale
      return { status: "stale", error: "No indexed events found" };
    }

    const ageMs = now - lastIndexedAt;
    if (ageMs > INDEX_STALENESS_THRESHOLD_MS) {
      return {
        status: "stale",
        error: `Index is ${Math.floor(ageMs / 1000)}s old (threshold: ${INDEX_STALENESS_THRESHOLD_MS / 1000}s)`,
      };
    }

    return { status: "ok" };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
