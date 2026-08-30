import { describe, it, expect, beforeEach } from "vitest";
import { InternalIndexerMetricsService } from "./metrics.js";

describe("InternalIndexerMetricsService", () => {
  let metrics: InternalIndexerMetricsService;

  beforeEach(() => {
    metrics = new InternalIndexerMetricsService();
  });

  it("starts with a zeroed unknown-topic counter", () => {
    expect(metrics.getEventsSkippedUnknownTopicTotal()).toBe(0);
    expect(metrics.getSnapshot().eventsSkippedUnknownTopicTotal).toBe(0);
    expect(metrics.getSnapshot().eventsSkippedUnknownTopicByTopic).toEqual({});
  });

  it("increments the total and per-topic breakdown on each skip", () => {
    metrics.incrementEventsSkippedUnknownTopic("trade_unknown_v9");
    metrics.incrementEventsSkippedUnknownTopic("trade_unknown_v9");
    metrics.incrementEventsSkippedUnknownTopic("resolution_unknown_v2");

    expect(metrics.getEventsSkippedUnknownTopicTotal()).toBe(3);
    expect(metrics.getSnapshot().eventsSkippedUnknownTopicByTopic).toEqual({
      trade_unknown_v9: 2,
      resolution_unknown_v2: 1,
    });
  });

  it("returns a structured, correlation-id-aware log payload without secrets", () => {
    const log = metrics.incrementEventsSkippedUnknownTopic(
      "trade_unknown_v9",
      "req-123"
    );

    expect(log).toEqual({
      event: "indexer.events.skipped_unknown_topic",
      topic: "trade_unknown_v9",
      requestId: "req-123",
      eventsSkippedUnknownTopicTotal: 1,
    });
  });

  it("includes the unknown-topic total in the log-fields snapshot", () => {
    metrics.incrementEventsSkippedUnknownTopic("trade_unknown_v9");
    const fields = metrics.toLogFields();
    expect(fields.eventsSkippedUnknownTopicTotal).toBe(1);
    expect(fields.event).toBe("indexer.metrics.snapshot");
  });

  it("tracks latestIndexedLedgerSequence independently of the topic counter", () => {
    metrics.setLatestIndexedLedgerSequence(42);
    metrics.incrementEventsSkippedUnknownTopic("trade_unknown_v9");

    const snapshot = metrics.getSnapshot();
    expect(snapshot.latestIndexedLedgerSequence).toBe(42);
    expect(snapshot.eventsSkippedUnknownTopicTotal).toBe(1);
  });
});
