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
 * Not started automatically: apps/indexer/src/main.ts only calls this when
 * INDEXER_HTTP_ENABLED=true, so the indexer's default off-chain
 * event-ingestion role stays HTTP-free unless an operator explicitly opts
 * in — see docs/docker-compose.md and docs/architecture.md.
 */
export async function buildIndexerHttpServer(options?: {
  readinessChecks?: ReadinessCheck[];
  logger?: ProbeLogger;
}): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  const readinessChecks = options?.readinessChecks ?? [];
  const logger = options?.logger;

  await app.register(indexerCorsPlugin);

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
