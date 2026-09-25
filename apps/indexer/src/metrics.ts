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
  }

  getLatestIndexedLedgerSequence(): number | null {
    return this.latestIndexedLedgerSequence;
  }

  setLatestNetworkLedgerSequence(sequence: number): void {
    this.latestNetworkLedgerSequence = sequence;
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
   * Increment the gap-detected counter by `count` (defaults to 1).
   * Called once per detected discontinuity.
   */
  incrementGapDetected(count = 1): void {
    this.gapDetectedTotal += count;
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
  }

  getBackfillLedgersTotal(): number {
    return this.backfillLedgersTotal;
  }

  /** Increment the parse-error counter by `count` (defaults to 1). */
  incrementParseError(count = 1): void {
    this.parseErrorTotal += count;
  }

  getParseErrorTotal(): number {
    return this.parseErrorTotal;
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
