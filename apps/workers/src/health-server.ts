import Fastify, { type FastifyInstance } from "fastify";
import type { ILogger } from "../../../packages/shared/src/logger.js";
import { liveRoutes } from "./routes/live.js";
import { readyRoutes } from "./routes/ready.js";

/**
 * Minimal HTTP server exposing `/live` and `/ready` for Kubernetes probes.
 *
 * This exists because, without a dedicated health server, worker
 * deployments have historically pointed their liveness/readiness probes at
 * the main API's `/health` endpoint (wrong process, wrong dependencies) or
 * at nothing at all. Pointing a worker's liveness probe at the API's
 * health check means k8s restarts worker pods based on the API process's
 * state, and pointing it at `/ready` (this module's dependency-checking
 * route) means a transient DB/Redis blip triggers unnecessary restarts.
 * Each worker entrypoint (expiry, reconciliation, settlement, oracle,
 * finalization, audit-archiver) should call `startHealthServer` alongside
 * its poll loop and configure k8s with:
 *   livenessProbe:  GET /live  (this process is alive — no deps)
 *   readinessProbe: GET /ready (this process can reach its dependencies)
 */
export async function startHealthServer(
  logger: ILogger,
  port: number
): Promise<FastifyInstance> {
  // port 0 is allowed (asks the OS for an ephemeral port, used by tests);
  // anything else negative or non-finite is a misconfiguration.
  if (!Number.isFinite(port) || port < 0) {
    throw new Error(`WORKERS_HEALTH_PORT must be >= 0, got: ${port}`);
  }

  const app = Fastify({ logger: false });
  await app.register(liveRoutes);
  await app.register(readyRoutes);

  try {
    await app.listen({ host: "0.0.0.0", port });
    logger.info("Workers health server listening", { port });
  } catch (error) {
    logger.error("Workers health server failed to start", {
      port,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  return app;
}
