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
 * Settlement outbox metrics (transactional outbox pattern for
 * MatchingService.placeOrder -> settlement queue delivery).
 * Updated by src/services/outbox-publisher.ts after each drain cycle.
 */
export const settlementOutboxDepthGauge = new client.Gauge({
  name: "vatix_settlement_outbox_depth",
  help: "Number of settlement outbox rows not yet PUBLISHED (PENDING + FAILED)",
  registers: [metricsRegistry],
});

export const settlementOutboxLagSecondsGauge = new client.Gauge({
  name: "vatix_settlement_outbox_lag_seconds",
  help: "Age in seconds of the oldest unpublished settlement outbox row",
  registers: [metricsRegistry],
});

export const settlementOutboxPublishFailuresTotal = new client.Counter({
  name: "vatix_settlement_outbox_publish_failures_total",
  help: "Total number of failed attempts to publish an outbox row to the settlement queue",
  registers: [metricsRegistry],
});

export const settlementOutboxOrphanedTradesGauge = new client.Gauge({
  name: "vatix_settlement_outbox_orphaned_trades",
  help: "Number of outbox rows that have failed to publish at least OUTBOX_ORPHAN_ATTEMPTS_THRESHOLD times",
  registers: [metricsRegistry],
});

export const settlementOutboxQuarantinedEntriesGauge = new client.Gauge({
  name: "vatix_settlement_outbox_quarantined_entries",
  help: "Number of outbox entries currently in QUARANTINED status",
  registers: [metricsRegistry],
});

export const settlementOutboxQuarantineTransitionsTotal = new client.Counter({
  name: "vatix_settlement_outbox_quarantine_transitions_total",
  help: "Total number of outbox entries moved to QUARANTINED status due to exceeding retry budget",
  registers: [metricsRegistry],
});

/**
 * 1 when this process currently holds the matching leader lease, else 0.
 * Updated by src/matching/leader-lease.ts.
 */
export const matchingLeaderGauge = new client.Gauge({
  name: "vatix_matching_leader",
  help: "Whether this process currently holds the matching leader lease (1) or not (0)",
  registers: [metricsRegistry],
});

/**
 * Incremented whenever a matching leader lease renewal/acquisition attempt
 * fails (lost lease or Redis unreachable). Updated by leader-lease.ts.
 */
export const matchingLeaseRenewFailuresTotal = new client.Counter({
  name: "vatix_matching_lease_renew_failures_total",
  help: "Total number of matching leader lease acquire/renew failures",
  registers: [metricsRegistry],
});

/**
 * Incremented when an oracle on-chain submission ends in an ambiguous state
 * (e.g. NOT_FOUND that may still confirm later).
 */
export const oracleSubmissionAmbiguousTotal = new client.Counter({
  name: "vatix_oracle_submission_ambiguous_total",
  help: "Total oracle submissions left in an ambiguous confirmation state",
  registers: [metricsRegistry],
});

/**
 * Latency from broadcast to confirmed for oracle resolve_market submissions.
 * Observed in milliseconds by the submission reconciliation worker.
 */
export const oracleSubmissionConfirmationLatency = new client.Histogram({
  name: "vatix_oracle_submission_confirmation_latency_ms",
  help: "Milliseconds from oracle submission broadcast to confirmation",
  registers: [metricsRegistry],
  buckets: [100, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000],
});

/**
 * Incremented every time two finalization workers race for the same
 * resolution_candidates row and one of them observes the row already
 * transitioned by the other (lock contention, not a failure).
 */
export const finalizationLockContentionTotal = new client.Counter({
  name: "vatix_finalization_lock_contention_total",
  help: "Total number of resolution_candidates row-lock contention events",
  registers: [metricsRegistry],
});

/**
 * Incremented when acquiring the resolution_candidates row lock throws
 * (DB unreachable, deadlock detected, statement timeout, etc). In
 * production this must fail the finalization job rather than silently
 * proceeding without the lock.
 */
export const finalizationLockFailuresTotal = new client.Counter({
  name: "vatix_finalization_lock_failures_total",
  help: "Total number of resolution_candidates row-lock acquisition failures",
  registers: [metricsRegistry],
});

/**
 * Incremented when BullMQ reports a stalled settlement job. A stalled job
 * that gets picked up by a second worker before the first one's lock
 * expires is exactly the double-apply-settle_trade failure mode this
 * metric exists to make visible.
 */
export const settlementJobStalledTotal = new client.Counter({
  name: "vatix_settlement_job_stalled_total",
  help: "Total number of settlement jobs BullMQ reported as stalled",
  registers: [metricsRegistry],
});

/**
 * Incremented when the settlement worker detects it is processing a job
 * whose idempotency key was already claimed by another attempt, and skips
 * re-executing settle_trade.
 */
export const settlementDuplicateSkippedTotal = new client.Counter({
  name: "vatix_settlement_duplicate_skipped_total",
  help: "Total number of duplicate settlement job executions skipped",
  registers: [metricsRegistry],
});

/**
 * Incremented when a settlement error is classified as fatal/invalid_input
 * and therefore quarantined (moved to the dead-letter path) instead of
 * being retried indefinitely.
 */
export const settlementErrorQuarantinedTotal = new client.Counter({
  name: "vatix_settlement_error_quarantined_total",
  help: "Total number of settlement job errors quarantined instead of retried",
  labelNames: ["code"] as const,
  registers: [metricsRegistry],
});
