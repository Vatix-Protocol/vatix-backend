import type { FastifyInstance } from "fastify";

interface LiveResponse {
  live: true;
  service: string;
  timestamp: string;
}

/**
 * Kubernetes liveness probe. Intentionally checks only that the process
 * event loop is responsive — it must NOT check downstream dependencies
 * (database, Redis). Wiring a liveness probe to a dependency-checking
 * endpoint (as `/ready` does) causes k8s to restart worker pods on a
 * transient database/Redis blip, which is the opposite of what liveness
 * probes are for and can cascade into a restart storm that drops
 * in-flight trades, resolutions, and admin actions. Use `/ready` (see
 * ready.ts) for readiness probes and this endpoint for liveness probes.
 */
export async function liveRoutes(fastify: FastifyInstance) {
  fastify.get<{ Reply: LiveResponse }>("/live", async (request, reply) => {
    const requestId =
      (request.headers["x-request-id"] as string | undefined) ?? request.id;

    reply.header("x-request-id", requestId);

    return reply.status(200).send({
      live: true,
      service: "vatix-workers",
      timestamp: new Date().toISOString(),
    });
  });
}
