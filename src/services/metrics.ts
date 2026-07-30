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
 * Incremented whenever a broadcast oracle resolution transaction cannot be
 * definitively classified as confirmed or non-included (e.g. the worker
 * crashed/restarted before confirmation was observed, or the RPC node has
 * not yet indexed the tx and its timebound has not yet expired). Ambiguous
 * submissions are held for reconciliation rather than resubmitted, since
 * resubmitting an ambiguous tx risks double-submitting a resolution (#996).
 */
export const oracleSubmissionAmbiguousTotal = new client.Counter({
  name: "vatix_oracle_submission_ambiguous_total",
  help: "Total number of oracle submissions left in an ambiguous (unconfirmed, non-resubmittable) state pending reconciliation",
  registers: [metricsRegistry],
});

/**
 * Time between a resolution tx being broadcast (sendTransaction returning a
 * hash) and its confirmation being observed on-chain, in milliseconds (#996).
 */
export const oracleSubmissionConfirmationLatency = new client.Histogram({
  name: "vatix_oracle_submission_confirmation_latency_ms",
  help: "Latency between oracle resolution tx broadcast and observed on-chain confirmation, in milliseconds",
  buckets: [500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000],
  registers: [metricsRegistry],
});

/**
 * Incremented by scripts/replay-market.ts whenever a market+outcome replay
 * detects a divergence between ledger truth and the replayed book (or its
 * cached Redis depth snapshot). Intended to be run on a sample of markets
 * continuously in staging so a regression in matching/fill accounting shows
 * up as a metric trend rather than only being found during an incident
 * postmortem.
 */
export const replayDivergenceTotal = new client.Counter({
  name: "vatix_replay_divergence_total",
  help: "Total number of market+outcome replays that found a divergence from ledger truth",
  registers: [metricsRegistry],
});
