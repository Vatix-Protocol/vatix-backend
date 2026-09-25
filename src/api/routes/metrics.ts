/**
 * GET /metrics — Prometheus scrape endpoint (#745, #1130)
 *
 * Registered unprefixed (not under /v1) and excluded from rate limiting,
 * mirroring the health/ready probes: scrapers poll frequently and must
 * never be blocked by the request-rate limiter. Because it is therefore
 * outside the global request middleware's protection, it carries its own
 * authorization (#1130) — a bearer token and/or source-address allowlist,
 * resolved once at boot from the validated API env. Denials are counted and
 * logged without ever echoing the presented credential.
 */
import type { FastifyInstance } from "fastify";
import {
  metricsRegistry,
  metricsScrapeRejectedTotal,
} from "../../services/metrics.js";
import { metricsScrapePolicy } from "../../config.js";
import { authorizeMetricsScrape } from "../middleware/metricsAuth.js";

export async function metricsRoutes(fastify: FastifyInstance) {
  fastify.get("/metrics", async (request, reply) => {
    const decision = authorizeMetricsScrape(
      {
        authorization: request.headers.authorization,
        remoteAddress: request.ip,
      },
      metricsScrapePolicy
    );

    if (!decision.allowed) {
      metricsScrapeRejectedTotal.inc({ reason: decision.reason });
      request.log.warn(
        {
          event: "metrics.scrape_denied",
          reason: decision.reason,
          code: decision.code,
          remoteAddress: request.ip,
        },
        "Metrics scrape denied"
      );
      if (decision.statusCode === 401) {
        reply.header("WWW-Authenticate", 'Bearer realm="metrics"');
      }
      return reply.status(decision.statusCode).send({
        error: decision.message,
        code: decision.code,
        requestId: request.id,
        statusCode: decision.statusCode,
      });
    }

    reply.header("Content-Type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
}
