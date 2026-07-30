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

/**
 * Incremented by OracleService whenever every provider (primary + fallback)
 * fails for a resolution request and the oracle fails closed — i.e. no
 * OracleReport is written and nothing is submitted on-chain (#717 fail-closed
 * behavior, #810 observability).
 */
export const oracleFailClosedTotal = new client.Counter({
  name: "vatix_oracle_fail_closed_total",
  help: "Total number of times the oracle failed closed after all providers were unreachable",
  registers: [metricsRegistry],
});

/**
 * Whether this process currently holds the matching leader lease: 1 while
 * held, 0 otherwise (including before first acquisition and after loss).
 * Only the lease holder is allowed to match orders — see
 * src/matching/leader-lease.ts. Alert if no process reports 1 for an
 * extended period, or if more than one process reports 1 simultaneously
 * (the latter would indicate a fencing bug, not a healthy state).
 */
export const matchingLeaderGauge = new client.Gauge({
  name: "vatix_matching_leader",
  help: "Whether this process currently holds the matching leader lease (1) or not (0)",
  registers: [metricsRegistry],
});

/**
 * Incremented every time this process fails to acquire or renew the
 * matching leader lease, whether because another instance holds it or
 * because Redis was unreachable. A rising rate on the current leader
 * indicates it is at risk of losing (or has lost) matching authority.
 */
export const matchingLeaseRenewFailuresTotal = new client.Counter({
  name: "vatix_matching_lease_renew_failures_total",
  help: "Total number of failed matching leader lease acquire/renew attempts",
  registers: [metricsRegistry],
});
