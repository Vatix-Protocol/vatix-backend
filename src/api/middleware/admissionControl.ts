import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { lagDetector, type LagMetrics } from "../../services/lag-detector.js";
import {
  incrementOrdersShed,
  setCurrentLag,
  setShedState,
} from "../../services/lag-metrics.js";

export class BackpressureError extends Error {
  constructor(
    public readonly metrics: LagMetrics,
    public readonly retryAfterSeconds: number = 30
  ) {
    super("Service backpressured due to downstream lag");
    this.name = "BackpressureError";
  }
}

/**
 * Admission control middleware: shed order traffic when settlement lag exceeds SLO
 * Skips checks for order cancellations and admin-initiated requests
 */
export async function admissionControl(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Skip admission control for cancellations and admin endpoints
  const isCancellation =
    request.method === "DELETE" ||
    (request.method === "POST" && request.url.includes("/cancel"));
  const isAdmin = request.url.includes("/admin/");

  if (isCancellation || isAdmin) {
    return; // Allow cancellations and admin operations during backpressure
  }

  // Check if we're shedding traffic
  const metrics = await lagDetector.getMetrics();

  // Update metrics
  setCurrentLag(metrics.totalLag);
  setShedState(metrics.shedding);

  if (metrics.shedding) {
    // Increment shed counter and return 503 Service Unavailable
    incrementOrdersShed(1);
    reply.status(503);
    reply.header("Retry-After", "30");

    return reply.send({
      error: "matching_backpressured",
      message:
        "Service is experiencing high settlement lag. Please retry after a short delay.",
      details: {
        settlementQueueDepth: metrics.settlementQueueDepth,
        outboxUnpublishedCount: metrics.outboxUnpublishedCount,
        totalLag: metrics.totalLag,
      },
      retryAfterSeconds: 30,
    });
  }
}

/**
 * Register admission control middleware
 */
export function registerAdmissionControl(fastify: FastifyInstance): void {
  fastify.addHook("onRequest", admissionControl);
}
