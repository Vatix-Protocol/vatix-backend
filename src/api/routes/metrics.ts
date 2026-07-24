/**
 * GET /metrics — Prometheus scrape endpoint (#745)
 *
 * Registered unprefixed (not under /v1) and excluded from rate limiting,
 * mirroring the health/ready probes: scrapers poll frequently and must
 * never be blocked by the request-rate limiter or an auth guard.
 */
import type { FastifyInstance } from "fastify";
import { metricsRegistry } from "../../services/metrics.js";

export async function metricsRoutes(fastify: FastifyInstance) {
  fastify.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
}
