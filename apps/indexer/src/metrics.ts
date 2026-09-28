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
  | "completed"
  | "paused"
  | "disabled"
  | "in_progress"
  | "dependency_unavailable"
  | "failed";

/**
 * Total number of ledger gap back-fill runs by terminal outcome. Operators
 * alert on any non-`completed` outcome: `dependency_unavailable` and `failed`
 * indicate the indexer is not catching up, while `paused` means ingestion has
 * deliberately halted (fail-closed) and needs a human (#1151).
 */
export const gapBackfillOutcomeTotalCounter = new client.Counter({
  name: "vatix_indexer_gap_backfill_outcome_total",
  help: "Total number of ledger gap back-fill runs by terminal outcome",
  labelNames: ["outcome"],
  registers: [indexerMetricsRegistry],
});

// ---------------------------------------------------------------------------
// In-memory metrics service (also updates Prometheus metrics)
// ---------------------------------------------------------------------------

export interface IndexerMetricsSnapshot {
  latestIndexedLedgerSequence: number | null;
  latestNetworkLedgerSequence: number | null;
  /** Difference between the latest network ledger and the indexed ledger, or null if both are unknown. */
  lag: number | null;
  /** Total number of ledger gaps detected since process start. */
  gapDetectedTotal: number;
  /** Total number of ledgers back-filled during gap catch-up since process start. */
  backfillLedgersTotal: number;
  /** Total number of event parse errors (all parsers) since process start. */
  parseErrorTotal: number;
  /** Current lag SLO health state (#1178). */
  lagSloState: IndexerLagSloState;
  /** Configured lag SLO target in ledgers (#1178). */
  lagSloTarget: number;
}

/** Typed payload used when logging a metrics snapshot. */
export interface IndexerMetricsLog {
  event: "indexer.metrics.snapshot";
  latestIndexedLedgerSequence: number | null;
  latestNetworkLedgerSequence: number | null;
  lag: number | null;
  gapDetectedTotal: number;
  backfillLedgersTotal: number;
  parseErrorTotal: number;
  lagSloState: IndexerLagSloState;
  lagSloTarget: number;
}

export class InternalIndexerMetricsService {
  private latestIndexedLedgerSequence: number | null = null;
  private latestNetworkLedgerSequence: number | null = null;
  /** Running count of gaps detected since process start. */
  private gapDetectedTotal = 0;
  /** Running total of ledgers back-filled since process start. */
  private backfillLedgersTotal = 0;
  /** Running total of event parse errors (all parsers) since process start. */
  private parseErrorTotal = 0;
  /** Configured lag SLO target in ledgers (#1178). */
  private readonly lagSloTarget: number;

  constructor(lagSloTarget: number = resolveIndexerLagSloLedgers()) {
    this.lagSloTarget = lagSloTarget;
    indexerLagSloTargetGauge.set(lagSloTarget);
  }

  setLatestIndexedLedgerSequence(sequence: number): void {
    this.latestIndexedLedgerSequence = sequence;
    latestIndexedLedgerSequenceGauge.set(sequence);
    // Update the derived lag metric whenever either input changes
    this.syncLag();
  }

  getLatestIndexedLedgerSequence(): number | null {
    return this.latestIndexedLedgerSequence;
  }

  setLatestNetworkLedgerSequence(sequence: number): void {
    this.latestNetworkLedgerSequence = sequence;
    latestNetworkLedgerSequenceGauge.set(sequence);
    // Update the derived lag metric whenever either input changes
    this.syncLag();
  }

  getLatestNetworkLedgerSequence(): number | null {
    return this.latestNetworkLedgerSequence;
  }

  /** Compute the current lag: networkLedger - indexedLedger. Returns null when either value is unknown. */
  getLag(): number | null {
    if (
      this.latestNetworkLedgerSequence === null ||
      this.latestIndexedLedgerSequence === null
    ) {
      return null;
    }
    return Math.max(
      0,
      this.latestNetworkLedgerSequence - this.latestIndexedLedgerSequence
    );
  }

  /** The configured lag SLO target in ledgers (#1178). */
  getLagSloTarget(): number {
    return this.lagSloTarget;
  }

  /**
   * Evaluate the current lag against the SLO target (#1178).
   *
   * Returns `unknown` when lag cannot be computed, `breach` when lag exceeds
   * the target, and `ok` otherwise. Pure with respect to in-memory state; the
   * Prometheus gauges/counters are updated by `syncLag`.
   */
  evaluateLagSlo(): IndexerLagSloEvaluation {
    const lag = this.getLag();
    if (lag === null) {
      return { state: "unknown", lag: null, target: this.lagSloTarget, breached: false };
    }
    if (lag > this.lagSloTarget) {
      return {
        state: "breach",
        lag,
        target: this.lagSloTarget,
        breached: true,
        code: INDEXER_LAG_SLO_BREACH_CODE,
      };
    }
    return { state: "ok", lag, target: this.lagSloTarget, breached: false };
  }

  /**
   * Build a typed, secret-free log payload for the current SLO evaluation
   * (#1178). Callers log this on every evaluation so a breach is observable
   * rather than silently ignored.
   */
  buildLagSloLog(): IndexerLagSloLog {
    const evaluation = this.evaluateLagSlo();
    const log: IndexerLagSloLog = {
      event: "indexer.lag_slo.evaluated",
      state: evaluation.state,
      lag: evaluation.lag,
      target: evaluation.target,
    };
    if (evaluation.code) {
      log.code = evaluation.code;
    }
    return log;
  }

  /**
   * Sync the Prometheus lag gauge with the current in-memory state.
   * Called automatically by setLatestIndexedLedgerSequence and
   * setLatestNetworkLedgerSequence; exposed publicly so callers can
   * re-sync after batch updates if needed.
   *
   * Also records the lag SLO health state and evaluation counter (#1178) so a
   * breach is always observable via metrics, never silently dropped.
   */
  syncLag(): void {
    const lag = this.getLag();
    if (lag !== null) {
      indexerLagGauge.set(lag);
    }
    const evaluation = this.evaluateLagSlo();
    indexerLagSloStateGauge.set({ state: "ok" }, evaluation.state === "ok" ? 1 : 0);
    indexerLagSloStateGauge.set({ state: "breach" }, evaluation.state === "breach" ? 1 : 0);
    indexerLagSloStateGauge.set({ state: "unknown" }, evaluation.state === "unknown" ? 1 : 0);
    indexerLagSloEvaluationsTotalCounter.inc({ state: evaluation.state });
  }

  /**
   * Increment the gap-detected counter by `count` (defaults to 1).
   * Called once per detected discontinuity.
   */
  incrementGapDetected(count = 1): void {
    this.gapDetectedTotal += count;
    gapDetectedTotalCounter.inc(count);
  }

  /**
   * Increment the back-filled ledgers counter by `count` (defaults to 1).
   * Called once per ledger back-filled during gap catch-up.
   */
  incrementBackfillLedgers(count = 1): void {
    this.backfillLedgersTotal += count;
    backfillLedgersTotalCounter.inc(count);
  }

  /**
   * Increment the parse-error counter by `count` (defaults to 1).
   * Called once per event parse failure.
   */
  incrementParseError(count = 1): void {
    this.parseErrorTotal += count;
    parseErrorTotalCounter.inc(count);
  }

  /**
   * Snapshot the current in-memory metrics, including the lag SLO state and
   * target (#1178).
   */
  getSnapshot(): IndexerMetricsSnapshot {
    const evaluation = this.evaluateLagSlo();
    return {
      latestIndexedLedgerSequence: this.latestIndexedLedgerSequence,
      latestNetworkLedgerSequence: this.latestNetworkLedgerSequence,
      lag: this.getLag(),
      gapDetectedTotal: this.gapDetectedTotal,
      backfillLedgersTotal: this.backfillLedgersTotal,
      parseErrorTotal: this.parseErrorTotal,
      lagSloState: evaluation.state,
      lagSloTarget: this.lagSloTarget,
    };
  }

  /**
   * Build a typed, secret-free log payload for the current metrics snapshot,
   * including the lag SLO state and target (#1178).
   */
  buildLog(): IndexerMetricsLog {
    const snapshot = this.getSnapshot();
    return {
      event: "indexer.metrics.snapshot",
      latestIndexedLedgerSequence: snapshot.latestIndexedLedgerSequence,
      latestNetworkLedgerSequence: snapshot.latestNetworkLedgerSequence,
      lag: snapshot.lag,
      gapDetectedTotal: snapshot.gapDetectedTotal,
      backfillLedgersTotal: snapshot.backfillLedgersTotal,
      parseErrorTotal: snapshot.parseErrorTotal,
      lagSloState: snapshot.lagSloState,
      lagSloTarget: snapshot.lagSloTarget,
    };
  }
}
