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
 * Per-market shedding registry.
 *
 * Markets are added here when their per-market lag (if tracked) exceeds
 * PER_MARKET_SHED_THRESHOLD, and removed once lag drops below
 * PER_MARKET_RECOVERY_THRESHOLD. This prevents one toxic market from stalling
 * global order placement (issue #967).
 *
 * Operators can seed or inspect the set via the exported helpers below.
 */
const shedMarkets = new Set<string>();

/**
 * Per-market shed thresholds — independent of the global thresholds so
 * operators can tune them separately.
 *
 * Override via environment variables:
 *   PER_MARKET_SHED_THRESHOLD      — default: 500
 *   PER_MARKET_RECOVERY_THRESHOLD  — default: 250
 */
function loadPerMarketThresholds(): { shed: number; recovery: number } {
  function parsePositiveInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw || raw.trim() === "") return fallback;
    const v = Number(raw);
    return Number.isInteger(v) && v > 0 ? v : fallback;
  }
  return {
    shed: parsePositiveInt("PER_MARKET_SHED_THRESHOLD", 500),
    recovery: parsePositiveInt("PER_MARKET_RECOVERY_THRESHOLD", 250),
  };
}

/**
 * Update shedding state for a specific market.
 *
 * Called by market-scoped lag probes (e.g. the settlement worker can emit
 * per-market depth metrics). The global admission-control middleware reads
 * `shedMarkets` on each request.
 *
 * @param marketId  Market UUID
 * @param lag       Current per-market lag score (same weighted formula as global)
 */
export function updateMarketShedState(marketId: string, lag: number): void {
  const { shed, recovery } = loadPerMarketThresholds();

  if (!shedMarkets.has(marketId) && lag >= shed) {
    shedMarkets.add(marketId);
    console.warn("Per-market shedding activated", {
      marketId,
      lag,
      threshold: shed,
      component: "admission-control",
    });
  } else if (shedMarkets.has(marketId) && lag <= recovery) {
    shedMarkets.delete(marketId);
    console.info("Per-market shedding deactivated", {
      marketId,
      lag,
      recovery,
      component: "admission-control",
    });
  }
}

/**
 * Returns the set of currently shed market IDs (snapshot copy).
 * Exported for observability and testing.
 */
export function getShedMarkets(): ReadonlySet<string> {
  return new Set(shedMarkets);
}

/**
 * Forcibly clear all per-market shed state.
 * Intended for operator use (manual incident recovery) and test teardown.
 */
export function clearShedMarkets(): void {
  shedMarkets.clear();
}

/**
 * Extract the market ID from a request path, if present.
 *
 * Handles paths of the form:
 *   POST /v1/orders           — body.marketId
 *   GET  /v1/markets/:id/...  — URL segment after /markets/
 */
function extractMarketId(request: FastifyRequest): string | undefined {
  // Body-based (order placement)
  const body = request.body as Record<string, unknown> | null | undefined;
  if (body && typeof body.marketId === "string" && body.marketId) {
    return body.marketId;
  }

  // URL-based (/v1/markets/:id/...)
  const match = request.url.match(/\/markets\/([^/?#]+)/);
  if (match) return match[1];

  // Route params (populated by Fastify after route matching)
  const params = (request as any).params as Record<string, unknown> | undefined;
  if (params && typeof params.id === "string" && params.id) {
    return params.id;
  }

  return undefined;
}

/**
 * Admission control middleware: shed order traffic when settlement lag exceeds SLO.
 *
 * Shedding operates at two levels:
 *   1. Global — when the aggregate settlement lag exceeds SETTLEMENT_LAG_SHED_THRESHOLD.
 *   2. Per-market — when a specific market's lag exceeds PER_MARKET_SHED_THRESHOLD,
 *      only requests targeting that market are rejected (issue #967).
 *
 * Skips checks for order cancellations and admin-initiated requests.
 * Fails closed (sheds traffic) if lag probe errors in production.
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

  // --- Per-market shedding check (fast-path, no I/O) ---
  // This runs before the global probe to short-circuit early for known-bad markets.
  const marketId = extractMarketId(request);
  if (marketId && shedMarkets.has(marketId)) {
    incrementOrdersShed(1);
    reply.status(503);
    reply.header("Retry-After", "30");
    return reply.send({
      error: "market_backpressured",
      message:
        "This market is experiencing high settlement lag. Please retry after a short delay.",
      details: { marketId },
      retryAfterSeconds: 30,
    });
  }

  try {
    // --- Global shedding check ---
    const metrics = await lagDetector.getMetrics();

    // Update global metrics gauges
    setCurrentLag(metrics.totalLag);
    setShedState(metrics.shedding);

    if (metrics.shedding) {
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
  } catch (error) {
    // Fail closed: probe error means unknown/unhealthy state.
    // Always shed traffic in production on probe failure.
    const isProd = process.env.NODE_ENV === "production";
    if (isProd) {
      incrementOrdersShed(1);
      reply.status(503);
      reply.header("Retry-After", "30");

      console.error("Lag detector probe failed, failing closed", {
        error: error instanceof Error ? error.message : String(error),
        component: "admission-control",
      });

      return reply.send({
        error: "lag_detector_probe_failed",
        message:
          "Service is unable to probe settlement health. Requests are being shed as a precaution.",
        retryAfterSeconds: 30,
      });
    }
    // In non-production, allow request through but log the error
    console.warn(
      "Lag detector probe failed in non-production, allowing request",
      {
        error: error instanceof Error ? error.message : String(error),
        nodeEnv: process.env.NODE_ENV,
      }
    );
  }
}

/**
 * Register admission control middleware
 */
export function registerAdmissionControl(fastify: FastifyInstance): void {
  fastify.addHook("onRequest", admissionControl);
}
