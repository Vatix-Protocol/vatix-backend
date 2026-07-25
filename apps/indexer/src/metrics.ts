export interface IndexerMetricsSnapshot {
  latestIndexedLedgerSequence: number | null;
  latestNetworkLedgerSequence: number | null;
  /** Difference between the latest network ledger and the indexed ledger, or null if both are unknown. */
  lag: number | null;
}

/** Typed payload used when logging a metrics snapshot. */
export interface IndexerMetricsLog {
  event: "indexer.metrics.snapshot";
  latestIndexedLedgerSequence: number | null;
  latestNetworkLedgerSequence: number | null;
  lag: number | null;
}

export class InternalIndexerMetricsService {
  private latestIndexedLedgerSequence: number | null = null;
  private latestNetworkLedgerSequence: number | null = null;

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

  getSnapshot(): IndexerMetricsSnapshot {
    return {
      latestIndexedLedgerSequence: this.latestIndexedLedgerSequence,
      latestNetworkLedgerSequence: this.latestNetworkLedgerSequence,
      lag: this.getLag(),
    };
  }

  toLogFields(): IndexerMetricsLog {
    return {
      event: "indexer.metrics.snapshot",
      latestIndexedLedgerSequence: this.latestIndexedLedgerSequence,
      latestNetworkLedgerSequence: this.latestNetworkLedgerSequence,
      lag: this.getLag(),
    };
  }
}
