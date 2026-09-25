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

  /**
   * Sync the Prometheus lag gauge with the current in-memory state.
   * Called automatically by setLatestIndexedLedgerSequence and
   * setLatestNetworkLedgerSequence; exposed publicly so callers can
   * re-sync after batch updates if needed.
   */
  syncLag(): void {
    const lag = this.getLag();
    if (lag !== null) {
      indexerLagGauge.set(lag);
    }
  }

  /**
   * Increment the gap-detected counter by `count` (defaults to 1).
   * Called once per detected discontinuity.
   */
  incrementGapDetected(count = 1): void {
    this.gapDetectedTotal += count;
    gapDetectedTotalCounter.inc(count);
  }

  getGapDetectedTotal(): number {
    return this.gapDetectedTotal;
  }

  /**
   * Increment the backfill-ledgers counter by the number of ledgers
   * that were re-fetched during a gap catch-up.
   */
  incrementBackfillLedgers(count: number): void {
    this.backfillLedgersTotal += count;
    backfillLedgersTotalCounter.inc(count);
  }

  getBackfillLedgersTotal(): number {
    return this.backfillLedgersTotal;
  }

  /** Increment the parse-error counter by `count` (defaults to 1). */
  incrementParseError(count = 1): void {
    this.parseErrorTotal += count;
    parseErrorTotalCounter.inc(count);
  }

  getParseErrorTotal(): number {
    return this.parseErrorTotal;
  }

  /**
   * Increment the batch-rejected counter. Called by the batch writer's size /
   * input guards before any database work happens (#1152). Counter-only — it
   * is intentionally excluded from the JSON snapshot because it is a
   * Prometheus-only alerting signal.
   */
  incrementBatchRejected(reason: BatchRejectedReason, count = 1): void {
    batchRejectedTotalCounter.inc({ reason }, count);
  }

  /**
   * Record the terminal outcome of a gap back-fill run so operators can alert
   * on stalled catch-up (#1151). Counter-only — see `incrementBatchRejected`.
   */
  incrementGapBackfillOutcome(outcome: GapBackfillOutcome, count = 1): void {
    gapBackfillOutcomeTotalCounter.inc({ outcome }, count);
  }

  getSnapshot(): IndexerMetricsSnapshot {
    return {
      latestIndexedLedgerSequence: this.latestIndexedLedgerSequence,
      latestNetworkLedgerSequence: this.latestNetworkLedgerSequence,
      lag: this.getLag(),
      gapDetectedTotal: this.gapDetectedTotal,
      backfillLedgersTotal: this.backfillLedgersTotal,
      parseErrorTotal: this.parseErrorTotal,
    };
  }

  toLogFields(): IndexerMetricsLog {
    return {
      event: "indexer.metrics.snapshot",
      latestIndexedLedgerSequence: this.latestIndexedLedgerSequence,
      latestNetworkLedgerSequence: this.latestNetworkLedgerSequence,
      lag: this.getLag(),
      gapDetectedTotal: this.gapDetectedTotal,
      backfillLedgersTotal: this.backfillLedgersTotal,
      parseErrorTotal: this.parseErrorTotal,
    };
  }
}
