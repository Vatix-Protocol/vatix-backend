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
 * Per-provider oracle call outcomes (#1147 failover metrics).
 *
 * `provider` is the role the result came from — `primary` or `fallback` — and
 * `outcome` is `success` or `failure` for that provider call. The `outcome`
 * reflects the provider call itself, not the confidence gate that runs after
 * it, so `primary`/`fallback` success ratios stay a faithful failover signal.
 *
 * Alerting example (primary success share dropping while fallback usage rises):
 *   `sum(rate(vatix_oracle_provider_attempts_total{provider="fallback",outcome="success"}[5m])) > 0`
 *   is the "we are running on the fallback" condition. Both labels are part of
 *   the metric contract — never rename them without a docs + dashboard update.
 */
export const oracleProviderAttemptsTotal = new client.Counter({
  name: "vatix_oracle_provider_attempts_total",
  help: "Total oracle provider call outcomes by provider role (primary/fallback) and outcome (success/failure)",
  labelNames: ["provider", "outcome"] as const,
  registers: [metricsRegistry],
});

/**
 * Per-provider outcome inside the fallback *chain* (#1147). Unlike
 * `oracleProviderAttemptsTotal`, `provider` here is the concrete chain entry
 * that was tried (`fallback-1`, `fallback-2`, … or the configured `source`,
 * e.g. a provider hostname), so operators can see which specific fallback
 * provider is carrying traffic or flapping.
 */
export const oracleFallbackChainAttemptsTotal = new client.Counter({
  name: "vatix_oracle_fallback_chain_attempts_total",
  help: "Total outcomes of each provider tried inside the fallback provider chain, labelled by provider source and outcome",
  labelNames: ["provider", "outcome"] as const,
  registers: [metricsRegistry],
});

/**
 * Dry-run oracle evaluations (#1146). `would` is `submit` when the resolution
 * passed every gate and would have been enqueued for on-chain submission, and
 * `fail_closed` when the result would have been refused (below the confidence
 * threshold). Dry-run never writes an OracleReport and never enqueues.
 */
export const oracleDryRunEvaluationsTotal = new client.Counter({
  name: "vatix_oracle_dry_run_evaluations_total",
  help: "Total oracle resolutions evaluated in dry-run mode, by would-be outcome (submit/fail_closed)",
  labelNames: ["would"] as const,
  registers: [metricsRegistry],
});

/**
 * Market search requests served by GET /markets (#1145). `filtered` is `true`
 * when the caller supplied a text search term. Soft-deleted markets are
 * excluded from every value of `filtered` — the label is telemetry only and
 * must never be used to bypass the `deletedAt IS NULL` predicate.
 */
export const marketSearchRequestsTotal = new client.Counter({
  name: "vatix_market_search_requests_total",
  help: "Total market list/search requests, labelled by whether a text search term was supplied",
  labelNames: ["filtered"] as const,
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
 * Incremented once per broken link found while verifying a trade audit hash
 * chain — a `prevHash` that does not match the preceding entry's `entryHash`.
 * A non-zero rate means archived rows were deleted or expired out from under
 * the chain (issue #952): the hash chain can no longer prove completeness and
 * a restore drill from backup is required. Labelled by market.
 */
export const auditChainGapTotal = new client.Counter({
  name: "vatix_audit_chain_gap_total",
  help: "Total broken links detected in trade audit hash chains (missing/expired archived rows)",
  labelNames: ["market_id"],
  registers: [metricsRegistry],
});

/**
 * Scrapes rejected by the /metrics authz policy (#1130), labelled by reason
 * (`missing_token` | `invalid_token` | `ip_not_allowed` |
 * `auth_not_configured`). Alert on any non-zero rate: it means either a
 * misconfigured scraper (metrics gap) or probing of an internal endpoint.
 * Reasons are stable strings and never contain the presented credential.
 */
export const metricsScrapeRejectedTotal = new client.Counter({
  name: "vatix_metrics_scrape_rejected_total",
  help: "Total /metrics scrapes denied by the scrape authz policy, by reason",
  labelNames: ["reason"],
  registers: [metricsRegistry],
});
