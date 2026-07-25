/**
 * Prometheus metrics registry for the API process (#745).
 *
 * A single shared Registry backs the GET /metrics scrape endpoint
 * (see src/api/routes/metrics.ts). Default Node.js process/runtime metrics
 * are collected automatically; domain-specific metrics (e.g. the orderbook
 * hydrated-markets gauge, #746) register themselves against this registry.
 */
import client from "prom-client";

export const metricsRegistry = new client.Registry();

metricsRegistry.setDefaultLabels({
  service: process.env.SERVICE_NAME ?? "vatix-backend",
});

client.collectDefaultMetrics({ register: metricsRegistry, prefix: "vatix_" });

/**
 * Number of (marketId, outcome) order books currently held in memory by the
 * matching engine. Updated by src/matching/matching-service.ts whenever a
 * book is hydrated or invalidated (#746).
 */
export const orderbookHydratedMarketsGauge = new client.Gauge({
  name: "vatix_orderbook_hydrated_markets",
  help: "Number of (market, outcome) order books currently hydrated in memory",
  registers: [metricsRegistry],
});
