import { describe, it, expect } from "vitest";
import {
  InternalIndexerMetricsService,
  type IndexerMetricsLog,
} from "./metrics.js";

describe("InternalIndexerMetricsService", () => {
  it("initializes with latestIndexedLedgerSequence = null", () => {
    const service = new InternalIndexerMetricsService();
    expect(service.getLatestIndexedLedgerSequence()).toBeNull();
    expect(service.getLatestNetworkLedgerSequence()).toBeNull();
  });

  it("setLatestIndexedLedgerSequence updates the stored value", () => {
    const service = new InternalIndexerMetricsService();
    service.setLatestIndexedLedgerSequence(12345);
    expect(service.getLatestIndexedLedgerSequence()).toBe(12345);
  });

  it("setLatestNetworkLedgerSequence updates the stored value", () => {
    const service = new InternalIndexerMetricsService();
    service.setLatestNetworkLedgerSequence(67890);
    expect(service.getLatestNetworkLedgerSequence()).toBe(67890);
  });

  it("getLag returns null when both values are unknown", () => {
    const service = new InternalIndexerMetricsService();
    expect(service.getLag()).toBeNull();
  });

  it("getLag returns null when only network is known", () => {
    const service = new InternalIndexerMetricsService();
    service.setLatestNetworkLedgerSequence(500);
    expect(service.getLag()).toBeNull();
  });

  it("getLag returns null when only indexed is known", () => {
    const service = new InternalIndexerMetricsService();
    service.setLatestIndexedLedgerSequence(100);
    expect(service.getLag()).toBeNull();
  });

  it("getLag computes positive difference when indexed is behind", () => {
    const service = new InternalIndexerMetricsService();
    service.setLatestNetworkLedgerSequence(1000);
    service.setLatestIndexedLedgerSequence(950);
    expect(service.getLag()).toBe(50);
  });

  it("getLag returns 0 when indexed is caught up", () => {
    const service = new InternalIndexerMetricsService();
    service.setLatestNetworkLedgerSequence(500);
    service.setLatestIndexedLedgerSequence(500);
    expect(service.getLag()).toBe(0);
  });

  it("getLag clamps to 0 when indexed is ahead (edge case)", () => {
    const service = new InternalIndexerMetricsService();
    service.setLatestNetworkLedgerSequence(100);
    service.setLatestIndexedLedgerSequence(150);
    expect(service.getLag()).toBe(0);
  });

  it("getSnapshot returns the expected payload shape", () => {
    const service = new InternalIndexerMetricsService();
    service.setLatestNetworkLedgerSequence(200);
    service.setLatestIndexedLedgerSequence(150);
    const snapshot = service.getSnapshot();
    expect(snapshot).toEqual({
      latestIndexedLedgerSequence: 150,
      latestNetworkLedgerSequence: 200,
      lag: 50,
      gapDetectedTotal: 0,
      backfillLedgersTotal: 0,
    });
  });

  it("toLogFields returns a valid IndexerMetricsLog payload", () => {
    const service = new InternalIndexerMetricsService();
    service.setLatestNetworkLedgerSequence(100000);
    service.setLatestIndexedLedgerSequence(98765);
    const logPayload: IndexerMetricsLog = service.toLogFields();

    expect(logPayload).toEqual({
      event: "indexer.metrics.snapshot",
      latestIndexedLedgerSequence: 98765,
      latestNetworkLedgerSequence: 100000,
      lag: 1235,
      gapDetectedTotal: 0,
      backfillLedgersTotal: 0,
    });
  });

  // ── Gap counter tests ────────────────────────────────────────────────────

  it("gapDetectedTotal initializes to 0", () => {
    const service = new InternalIndexerMetricsService();
    expect(service.getGapDetectedTotal()).toBe(0);
  });

  it("incrementGapDetected increments by 1 by default", () => {
    const service = new InternalIndexerMetricsService();
    service.incrementGapDetected();
    expect(service.getGapDetectedTotal()).toBe(1);
  });

  it("incrementGapDetected increments by a custom count", () => {
    const service = new InternalIndexerMetricsService();
    service.incrementGapDetected(3);
    expect(service.getGapDetectedTotal()).toBe(3);
  });

  it("incrementGapDetected accumulates across multiple calls", () => {
    const service = new InternalIndexerMetricsService();
    service.incrementGapDetected();
    service.incrementGapDetected(2);
    service.incrementGapDetected();
    expect(service.getGapDetectedTotal()).toBe(4);
  });

  // ── Backfill ledger counter tests ────────────────────────────────────────

  it("backfillLedgersTotal initializes to 0", () => {
    const service = new InternalIndexerMetricsService();
    expect(service.getBackfillLedgersTotal()).toBe(0);
  });

  it("incrementBackfillLedgers increments by the given count", () => {
    const service = new InternalIndexerMetricsService();
    service.incrementBackfillLedgers(50);
    expect(service.getBackfillLedgersTotal()).toBe(50);
  });

  it("incrementBackfillLedgers accumulates across multiple calls", () => {
    const service = new InternalIndexerMetricsService();
    service.incrementBackfillLedgers(100);
    service.incrementBackfillLedgers(25);
    expect(service.getBackfillLedgersTotal()).toBe(125);
  });

  it("getSnapshot includes gap and backfill counters", () => {
    const service = new InternalIndexerMetricsService();
    service.incrementGapDetected();
    service.incrementGapDetected();
    service.incrementBackfillLedgers(200);

    const snapshot = service.getSnapshot();
    expect(snapshot.gapDetectedTotal).toBe(2);
    expect(snapshot.backfillLedgersTotal).toBe(200);
  });

  it("toLogFields includes gap and backfill counters", () => {
    const service = new InternalIndexerMetricsService();
    service.incrementGapDetected(5);
    service.incrementBackfillLedgers(300);

    const log = service.toLogFields();
    expect(log.gapDetectedTotal).toBe(5);
    expect(log.backfillLedgersTotal).toBe(300);
  });
});
