import { describe, it, expect } from "vitest";
import { InternalIndexerMetricsService, type IndexerMetricsLog } from "./metrics.js";

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

  it("verify the snapshot conforms to the IndexerMetricsLog contract", () => {
    const service = new InternalIndexerMetricsService();
    service.setLatestIndexedLedgerSequence(98765);
    const snapshot = service.getSnapshot();

    // Verify type assertion/satisfaction at compile time (TypeScript check)
    const logPayload: IndexerMetricsLog = snapshot;

    expect(logPayload).toEqual({
      latestIndexedLedgerSequence: 98765,
    });
  });
});
