export interface IndexerMetricsSnapshot {
  latestIndexedLedgerSequence: number | null;
  eventsSkippedUnknownTopicTotal: number;
  eventsSkippedUnknownTopicByTopic: Record<string, number>;
}

/** Typed payload used when logging a metrics snapshot. */
export interface IndexerMetricsLog {
  event: "indexer.metrics.snapshot";
  latestIndexedLedgerSequence: number | null;
  eventsSkippedUnknownTopicTotal: number;
}

/** Typed payload used when logging an individual unknown-topic skip. */
export interface UnknownTopicSkipLog {
  event: "indexer.events.skipped_unknown_topic";
  topic: string;
  requestId?: string;
  eventsSkippedUnknownTopicTotal: number;
}

export class InternalIndexerMetricsService {
  private latestIndexedLedgerSequence: number | null = null;
  private eventsSkippedUnknownTopicTotal = 0;
  private readonly eventsSkippedUnknownTopicByTopic = new Map<
    string,
    number
  >();

  setLatestIndexedLedgerSequence(sequence: number): void {
    this.latestIndexedLedgerSequence = sequence;
  }

  getLatestIndexedLedgerSequence(): number | null {
    return this.latestIndexedLedgerSequence;
  }

  /**
   * Record that a raw chain event was silently dropped because its topic
   * did not match any known handler. Without this counter, these drops are
   * invisible — no dashboard, no alert — and can mask lost trades,
   * resolutions, or admin actions. Returns a structured log payload the
   * caller can pass straight to its logger (never logs secrets, only the
   * topic name and an optional correlation id).
   */
  incrementEventsSkippedUnknownTopic(
    topic: string,
    requestId?: string
  ): UnknownTopicSkipLog {
    this.eventsSkippedUnknownTopicTotal += 1;
    this.eventsSkippedUnknownTopicByTopic.set(
      topic,
      (this.eventsSkippedUnknownTopicByTopic.get(topic) ?? 0) + 1
    );

    return {
      event: "indexer.events.skipped_unknown_topic",
      topic,
      requestId,
      eventsSkippedUnknownTopicTotal: this.eventsSkippedUnknownTopicTotal,
    };
  }

  getEventsSkippedUnknownTopicTotal(): number {
    return this.eventsSkippedUnknownTopicTotal;
  }

  getSnapshot(): IndexerMetricsSnapshot {
    return {
      latestIndexedLedgerSequence: this.latestIndexedLedgerSequence,
      eventsSkippedUnknownTopicTotal: this.eventsSkippedUnknownTopicTotal,
      eventsSkippedUnknownTopicByTopic: Object.fromEntries(
        this.eventsSkippedUnknownTopicByTopic
      ),
    };
  }

  toLogFields(): IndexerMetricsLog {
    return {
      event: "indexer.metrics.snapshot",
      latestIndexedLedgerSequence: this.latestIndexedLedgerSequence,
      eventsSkippedUnknownTopicTotal: this.eventsSkippedUnknownTopicTotal,
    };
  }
}
