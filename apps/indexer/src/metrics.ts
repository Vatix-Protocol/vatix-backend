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
 * Total number of ingestion ticks that failed (RPC fetch, parse, batch write
 * or checkpoint flush). This is the alerting signal for a stalled indexer:
 * a rising counter with a flat `vatix_indexer_lag` means the loop is alive
 * but not making progress.
 */
export const ingestionFailureTotalCounter = new client.Counter({
  name: "vatix_indexer_ingestion_failures_total",
  help: "Total number of failed ingestion ticks since process start",
  registers: [indexerMetricsRegistry],
});

/**
 * Number of consecutive failed ingestion ticks. Stays at 0 while the loop is
 * healthy; drives the loop's backoff schedule. Alert on this being > 0 for
 * longer than the RPC/client timeout budget.
 */
export const consecutiveIngestionFailuresGauge = new client.Gauge({
  name: "vatix_indexer_consecutive_ingestion_failures",
  help: "Number of consecutive failed ingestion ticks (0 while healthy)",
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
  /** Total number of failed ingestion ticks since process start. */
  ingestionFailureTotal: number;
  /** Consecutive failed ingestion ticks (0 while healthy). */
  consecutiveIngestionFailures: number;
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
  ingestionFailureTotal: number;
  consecutiveIngestionFailures: number;
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
  /** Running total of failed ingestion ticks since process start. */
  private ingestionFailureTotal = 0;
  /** Consecutive failed ingestion ticks; reset on the first healthy tick. */
  private consecutiveIngestionFailures = 0;

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
   * Record a failed ingestion tick. `consecutive` is the running streak
   * length; passing 0 (or calling {@link resetIngestionFailures}) means the
   * loop recovered and the gauge must be cleared.
   */
  incrementIngestionFailure(consecutive = 1): void {
    this.ingestionFailureTotal += 1;
    this.consecutiveIngestionFailures = consecutive;
    ingestionFailureTotalCounter.inc();
    consecutiveIngestionFailuresGauge.set(consecutive);
  }

  /** Clear the consecutive-failure streak after a healthy tick. */
  resetIngestionFailures(): void {
    this.consecutiveIngestionFailures = 0;
    consecutiveIngestionFailuresGauge.set(0);
  }

  getConsecutiveIngestionFailures(): number {
    return this.consecutiveIngestionFailures;
  }

  getIngestionFailureTotal(): number {
    return this.ingestionFailureTotal;
  }

  getSnapshot(): IndexerMetricsSnapshot {
    return {
      latestIndexedLedgerSequence: this.latestIndexedLedgerSequence,
      latestNetworkLedgerSequence: this.latestNetworkLedgerSequence,
      lag: this.getLag(),
      gapDetectedTotal: this.gapDetectedTotal,
      backfillLedgersTotal: this.backfillLedgersTotal,
      parseErrorTotal: this.parseErrorTotal,
      ingestionFailureTotal: this.ingestionFailureTotal,
      consecutiveIngestionFailures: this.consecutiveIngestionFailures,
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
      ingestionFailureTotal: this.ingestionFailureTotal,
      consecutiveIngestionFailures: this.consecutiveIngestionFailures,
    };
  }
}
