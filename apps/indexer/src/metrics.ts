export interface IndexerMetricsSnapshot {
  latestIndexedLedgerSequence: number | null;
}

export class InternalIndexerMetricsService {
  private latestIndexedLedgerSequence: number | null = null;

  setLatestIndexedLedgerSequence(sequence: number): void {
    this.latestIndexedLedgerSequence = sequence;
  }

  getLatestIndexedLedgerSequence(): number | null {
    return this.latestIndexedLedgerSequence;
  }

  getSnapshot(): IndexerMetricsSnapshot {
    return {
      latestIndexedLedgerSequence: this.latestIndexedLedgerSequence,
    };
  }
}
