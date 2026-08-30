/**
 * GET /v1/health — Liveness probe
 *
 * Signals that the process is alive and the HTTP server is responding.
 * Kubernetes uses this to decide whether to RESTART the pod.
 *
 * Liveness vs Readiness:
 *   - Liveness  (GET /v1/health): process is alive. Always returns 200
 *     while the HTTP server is up. Does NOT check DB or Redis — a DB blip
 *     must not cause a pod restart; use GET /v1/ready for that.
 *   - Readiness (GET /v1/ready): process can serve valid data.  Returns
 *     503 when a critical dependency (DB, index freshness) is unavailable
 *     so the load balancer stops routing traffic to this instance.
 *
 * Response shape:
 *   {
 *     "status": "ok",
 *     "service": string,
 *     "version": string,
 *     "uptime": number,
 *     "timestamp": string
 *   }
 *
 * HTTP status: always 200 while the process is alive.
 */

import type { FastifyInstance } from "fastify";

interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  uptime: number;
  timestamp: string;
}

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get<{ Reply: HealthResponse }>("/health", async (request, reply) => {
    const uptime = Math.floor(process.uptime());

    request.log.debug(
      {
        route: "/v1/health",
        uptime,
      },
      "Liveness check"
    );

    return reply.status(200).send({
      status: "ok",
      service: process.env.SERVICE_NAME ?? "vatix-backend",
      version: process.env.npm_package_version ?? "unknown",
      uptime,
      timestamp: new Date().toISOString(),
    });
  });
}
