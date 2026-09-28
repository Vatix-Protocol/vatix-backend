import client from "prom-client";

// ---------------------------------------------------------------------------
// Prometheus registry for indexer metrics
// ---------------------------------------------------------------------------

/**
 * Shared Prometheus Registry for the indexer's scrape endpoint.
 *
 * Separate from the main API process registry (src/services/metrics.ts).
 * Default Node.js process/runtime metrics are collected automatically via
 * collectDefaultMetrics, prefixed `vatix_`.
 */
export const indexerMetricsRegistry = new client.Registry();

client.collectDefaultMetrics({
  register: indexerMetricsRegistry,
  prefix: "vatix_",
});

// ---------------------------------------------------------------------------
// Indexer lag SLO (#1178)
// ---------------------------------------------------------------------------

/**
 * Default indexer lag SLO target, in ledgers.
 *
 * The indexer is considered healthy while `vatix_indexer_lag` stays at or
 * below this threshold. Matches the semantics documented in `docs/metrics.md`.
 * Overridable via the `INDEXER_LAG_SLO_LEDGERS` env var so operators can tune
 * the target per network (testnet vs mainnet) without a redeploy.
 */
export const DEFAULT_INDEXER_LAG_SLO_LEDGERS = 5;

/**
 * Resolve the configured lag SLO target. Falls back to the default when the
 * env var is unset or not a positive integer, so a bad config fails safe to
 * the documented default rather than disabling the SLO.
 */
export function resolveIndexerLagSloLedgers(
  raw: string | undefined = process.env.INDEXER_LAG_SLO_LEDGERS
): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_INDEXER_LAG_SLO_LEDGERS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_INDEXER_LAG_SLO_LEDGERS;
  }
  return parsed;
}

/**
 * Health state of the indexer relative to its lag SLO.
 *
 * - `ok`      — lag is known and within the SLO target.
 * - `breach`  — lag is known and exceeds the SLO target (fail-closed signal).
 * - `unknown` — lag cannot be computed yet (no network/indexed ledger seen).
 */
export type IndexerLagSloState = "ok" | "breach" | "unknown";

/**
 * Stable error code emitted when the lag SLO is breached. Callers surface
 * this instead of a free-form string so ops tooling and tests can match on it.
 */
export const INDEXER_LAG_SLO_BREACH_CODE = "INDEXER_LAG_SLO_BREACH" as const;

/**
 * Typed, secret-free log payload emitted on every SLO evaluation. Contains no
 * ledger contents, addresses, or credentials — only numeric lag/health data.
 */
export interface IndexerLagSloLog {
  event: "indexer.lag_slo.evaluated";
  state: IndexerLagSloState;
  lag: number | null;
  target: number;
  /** Stable error code, present only when `state === "breach"`. */
  code?: typeof INDEXER_LAG_SLO_BREACH_CODE;
}

/**
 * Result of evaluating the current lag against the SLO target.
 */
export interface IndexerLagSloEvaluation {
  state: IndexerLagSloState;
  lag: number | null;
  target: number;
  /** True only when lag is known and exceeds the target. */
  breached: boolean;
  /** Stable error code, present only on breach. */
  code?: typeof INDEXER_LAG_SLO_BREACH_CODE;
}

// ---------------------------------------------------------------------------
// DLQ depth alerts (#1179)
// ---------------------------------------------------------------------------

/**
 * Default dead-letter queue depth threshold, in messages.
 *
 * The DLQ is considered healthy while its depth stays at or below this
 * threshold. Matches the semantics documented in `docs/dead-letter-log.md`.
 * Overridable via the `DLQ_DEPTH_ALERT_THRESHOLD` env var so operators can
 * tune the target per network (testnet vs mainnet) without a redeploy.
 */
export const DEFAULT_DLQ_DEPTH_ALERT_THRESHOLD = 100;

/**
 * Resolve the configured DLQ depth alert threshold. Falls back to the default
 * when the env var is unset or not a positive integer, so a bad config fails
 * safe to the documented default rather than disabling the alert.
 */
export function resolveDlqDepthAlertThreshold(
  raw: string | undefined = process.env.DLQ_DEPTH_ALERT_THRESHOLD
): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_DLQ_DEPTH_ALERT_THRESHOLD;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_DLQ_DEPTH_ALERT_THRESHOLD;
  }
  return parsed;
}

/**
 * Health state of the dead-letter queue relative to its depth threshold.
 *
 * - `ok`      — depth is known and within the threshold.
 * - `breach`  — depth is known and exceeds the threshold (fail-closed signal).
 * - `unknown` — depth cannot be computed yet (no DLQ read succeeded).
 */
export type DlqDepthAlertState = "ok" | "breach" | "unknown";

/**
 * Stable error code emitted when the DLQ depth threshold is breached. Callers
 * surface this instead of a free-form string so ops tooling and tests can
 * match on it.
 */
export const DLQ_DEPTH_ALERT_BREACH_CODE = "DLQ_DEPTH_ALERT_BREACH" as const;

/**
 * Typed, secret-free log payload emitted on every DLQ depth evaluation.
 * Contains no message contents, addresses, or credentials — only numeric
 * depth/threshold data.
 */
export interface DlqDepthAlertLog {
  event: "dlq.depth_alert.evaluated";
  state: DlqDepthAlertState;
  depth: number | null;
  threshold: number;
  /** Stable error code, present only when `state === "breach"`. */
  code?: typeof DLQ_DEPTH_ALERT_BREACH_CODE;
}

/**
 * Result of evaluating the current DLQ depth against the alert threshold.
 */
export interface DlqDepthAlertEvaluation {
  state: DlqDepthAlertState;
  depth: number | null;
  threshold: number;
  /** True only when depth is known and exceeds the threshold. */
  breached: boolean;
  /** Stable error code, present only on breach. */
  code?: typeof DLQ_DEPTH_ALERT_BREACH_CODE;
}

/**
 * Evaluate the current DLQ depth against the alert threshold (#1179).
 *
 * Fail-closed semantics: a `null`/`undefined`/non-finite depth (e.g. the DLQ
 * backend is unreachable) yields `state: "unknown"` rather than a silent
 * `ok`, so a dependency outage cannot mask a growing backlog. The evaluation
 * is pure and idempotent — replaying the same depth yields the same result.
 */
export function evaluateDlqDepthAlert(
  depth: number | null | undefined,
  threshold: number = resolveDlqDepthAlertThreshold()
): DlqDepthAlertEvaluation {
  if (depth === null || depth === undefined || !Number.isFinite(depth)) {
    return { state: "unknown", depth: null, threshold, breached: false };
  }
  const breached = depth > threshold;
  return {
    state: breached ? "breach" : "ok",
    depth,
    threshold,
    breached,
    ...(breached ? { code: DLQ_DEPTH_ALERT_BREACH_CODE } : {}),
  };
}

// ---------------------------------------------------------------------------
// Prometheus metric definitions
// ---------------------------------------------------------------------------

/** Latest ledger sequence that has been successfully indexed. */
export const latestIndexedLedgerSequenceGauge = new client.Gauge({
  name: "vatix_indexer_latest_indexed_ledger_sequence",
  help: "Latest ledger sequence that has been successfully indexed",
  registers: [indexerMetricsRegistry],
});

/** Latest ledger sequence reported by the Stellar network. */
export const latestNetworkLedgerSequenceGauge = new client.Gauge({
  name: "vatix_indexer_latest_network_ledger_sequence",
  help: "Latest ledger sequence reported by the Stellar network",
  registers: [indexerMetricsRegistry],
});

/** Difference between the latest network ledger and the indexed ledger. */
export const indexerLagGauge = new client.Gauge({
  name: "vatix_indexer_lag",
  help: "Difference between the latest network ledger and the indexed ledger",
  registers: [indexerMetricsRegistry],
});

/**
 * Configured indexer lag SLO target in ledgers (#1178). Exposed as a gauge so
 * alert rules can compare `vatix_indexer_lag` against the live target without
 * hard-coding the threshold in the rule.
 */
export const indexerLagSloTargetGauge = new client.Gauge({
  name: "vatix_indexer_lag_slo_target_ledgers",
  help: "Configured indexer lag SLO target in ledgers",
  registers: [indexerMetricsRegistry],
});

/**
 * Current lag SLO health state as a gauge (#1178): 1 for the active state, 0
 * for the others, labelled by `state` (`ok` | `breach` | `unknown`). Lets
 * operators alert on `vatix_indexer_lag_slo_state{state="breach"} == 1`.
 */
export const indexerLagSloStateGauge = new client.Gauge({
  name: "vatix_indexer_lag_slo_state",
  help: "Current indexer lag SLO health state (1 for the active state)",
  labelNames: ["state"],
  registers: [indexerMetricsRegistry],
});

/**
 * Total number of lag SLO evaluations by resulting state (#1178). A rising
 * `breach` rate means the indexer is falling behind its target and needs
 * operator attention; `unknown` means lag cannot yet be computed.
 */
export const indexerLagSloEvaluationsTotalCounter = new client.Counter({
  name: "vatix_indexer_lag_slo_evaluations_total",
  help: "Total number of indexer lag SLO evaluations by resulting state",
  labelNames: ["state"],
  registers: [indexerMetricsRegistry],
});

/**
 * Current dead-letter queue depth in messages (#1179). Exposed as a gauge so
 * alert rules can compare it against the live threshold without hard-coding
 * the value in the rule.
 */
export const dlqDepthGauge = new client.Gauge({
  name: "vatix_indexer_dlq_depth",
  help: "Current dead-letter queue depth in messages",
  registers: [indexerMetricsRegistry],
});

/**
 * Configured DLQ depth alert threshold in messages (#1179). Exposed as a gauge
 * so alert rules can compare `vatix_indexer_dlq_depth` against the live
 * threshold without hard-coding it in the rule.
 */
export const dlqDepthAlertThresholdGauge = new client.Gauge({
  name: "vatix_indexer_dlq_depth_alert_threshold",
  help: "Configured dead-letter queue depth alert threshold in messages",
  registers: [indexerMetricsRegistry],
});

/**
 * Current DLQ depth alert state as a gauge (#1179): 1 for the active state, 0
 * for the others, labelled by `state` (`ok` | `breach` | `unknown`). Lets
 * operators alert on `vatix_indexer_dlq_depth_alert_state{state="breach"} == 1`.
 */
export const dlqDepthAlertStateGauge = new client.Gauge({
  name: "vatix_indexer_dlq_depth_alert_state",
  help: "Current DLQ depth alert state (1 for the active state)",
  labelNames: ["state"],
  registers: [indexerMetricsRegistry],
});

/**
 * Total number of DLQ depth alert evaluations by resulting state (#1179). A
 * rising `breach` rate means the dead-letter queue is growing past its
 * threshold and needs operator attention; `unknown` means depth cannot yet be
 * computed (fail-closed).
 */
export const dlqDepthAlertEvaluationsTotalCounter = new client.Counter({
  name: "vatix_indexer_dlq_depth_alert_evaluations_total",
  help: "Total number of DLQ depth alert evaluations by resulting state",
  labelNames: ["state"],
  registers: [indexerMetricsRegistry],
});

/** Total number of ledger gaps detected since process start. */
export const gapDetectedTotalCounter = new client.Counter({
  name: "vatix_indexer_gap_detected_total",
  help: "Total number of ledger gaps detected since process start",
  registers: [indexerMetricsRegistry],
});

/** Total number of ledgers back-filled during gap catch-up since process start. */
export const backfillLedgersTotalCounter = new client.Counter({
  name: "vatix_indexer_backfill_ledgers_total",
  help: "Total number of ledgers back-filled during gap catch-up since process start",
  registers: [indexerMetricsRegistry],
});

/** Total number of event parse errors (all parsers) since process start. */
export const parseErrorTotalCounter = new client.Counter({
  name: "vatix_indexer_parse_error_total",
  help: "Total number of event parse errors (all parsers) since process start",
  registers: [indexerMetricsRegistry],
});

/**
 * Why a batch write was rejected before touching the database (#1152).
 *
 * - `too_large`    — record count exceeded the configured hard cap (DoS guard).
 * - `invalid_input` — the batch was not an array of well-formed records.
 */
export type BatchRejectedReason = "too_large" | "invalid_input";

/**
 * Total number of indexer batches rejected *before* any persistence attempt,
 * labelled by reason. A non-zero rate means an upstream producer is sending
 * oversized or malformed batches — the guard fails closed instead of letting
 * the database absorb the load (#1152).
 */
export const batchRejectedTotalCounter = new client.Counter({
  name: "vatix_indexer_batch_rejected_total",
  help: "Total number of indexer batch writes rejected before persistence, by reason",
  labelNames: ["reason"],
  registers: [indexerMetricsRegistry],
});

/**
 * Terminal outcome of a ledger gap back-fill run (#1151).
 *
 * - `completed`              — the clamped range was fetched and written.
 * - `paused`                 — gap exceeded `gapPauseThreshold`; ingestion halts.
 * - `disabled`               — kill-switch `backfillEnabled=false`; nothing fetched.
 * - `in_progress`            — a concurrent back-fill was already running; denied.
 * - `dependency_unavailable` — the batch write failed closed (DB/RPC outage).
 * - `failed`                 — any other back-fill error.
 */
export type GapBackfillOutcome =
  |

/* … truncated 8324 chars — edit only what you need near the top … */
