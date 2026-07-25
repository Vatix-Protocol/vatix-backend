import { describe, it, expect } from "vitest";
import {
  InternalIndexerMetricsService,
  type IndexerMetricsLog,
} from "./metrics.js";

describe("InternalIndexerMetricsService", () => {
  it("initializes with latestIndexedLedgerSequence = null", () => {
    const service = new InternalIndexerMetricsService();
    expect(service.getLatestIndexedLedgerSequence()).toBeNull();
  });

  it("setLatestIndexedLedgerSequence updates the stored value", () => {
    const service = new InternalIndexerMetricsService();
    service.setLatestIndexedLedgerSequence(12345);
    expect(service.getLatestIndexedLedgerSequence()).toBe(12345);
  });

  it("getSnapshot returns the expected payload shape", () => {
    const service = new InternalIndexerMetricsService();
    const snapshot = service.getSnapshot();
    expect(snapshot).toEqual({
      latestIndexedLedgerSequence: null,
    });
  });

  it("toLogFields returns a valid IndexerMetricsLog payload", () => {
    const service = new InternalIndexerMetricsService();
    service.setLatestIndexedLedgerSequence(98765);
    const logPayload: IndexerMetricsLog = service.toLogFields();

    expect(logPayload).toEqual({
      event: "indexer.metrics.snapshot",
      latestIndexedLedgerSequence: 98765,
    });
  });
});
