import { describe, it, expect, beforeEach, vi, type MockInstance } from "vitest";
import { EventProcessor, type IndexerEvent } from "./event-processor";
import type { Trade } from "../matching/engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: "trade-1",
    marketId: "market-abc",
    outcome: "YES",
    buyerAddress: "GBUYER" + "A".repeat(50),
    sellerAddress: "GSELLER" + "A".repeat(49),
    buyOrderId: "buy-1",
    sellOrderId: "sell-1",
    price: 0.55,
    quantity: 100,
    timestamp: 1000,
    ...overrides,
  };
}

function makeEvent(
  id: string,
  ledgerSequence: number,
  trade?: Partial<Trade>
): IndexerEvent {
  return { id, ledgerSequence, trade: makeTrade({ id, ...trade }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EventProcessor — duplicate event handling", () => {
  let processor: EventProcessor;
  let handler: MockInstance & ((event: IndexerEvent) => Promise<void>);

  beforeEach(() => {
    processor = new EventProcessor();
    handler = vi.fn().mockResolvedValue(undefined) as MockInstance & ((event: IndexerEvent) => Promise<void>);
  });

  // -------------------------------------------------------------------------
  // Core idempotency
  // -------------------------------------------------------------------------

  it("processes a new event exactly once", async () => {
    const event = makeEvent("evt-1", 100);
    const result = await processor.processBatch([event], handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
    expect(result.duplicates).toBe(0);
  });

  it("skips a duplicate event in the same batch", async () => {
    const event = makeEvent("evt-1", 100);
    const result = await processor.processBatch([event, event], handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
    expect(result.duplicates).toBe(1);
  });

  it("skips a duplicate event replayed in a subsequent batch", async () => {
    const event = makeEvent("evt-1", 100);
    await processor.processBatch([event], handler);

    handler.mockClear();
    const result = await processor.processBatch([event], handler);

    expect(handler).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(result.duplicates).toBe(1);
  });

  // -------------------------------------------------------------------------
  // State integrity — replaying same batch keeps state unchanged
  // -------------------------------------------------------------------------

  it("replaying the same event batch keeps handler call count unchanged", async () => {
    const batch = [makeEvent("evt-1", 200), makeEvent("evt-2", 200)];

    await processor.processBatch(batch, handler);
    const callsAfterFirst = handler.mock.calls.length;

    await processor.processBatch(batch, handler); // replay
    expect(handler.mock.calls.length).toBe(callsAfterFirst); // no new calls
  });

  it("replaying same batch reports all events as duplicates", async () => {
    const batch = [makeEvent("evt-1", 200), makeEvent("evt-2", 200)];
    await processor.processBatch(batch, handler);

    const result = await processor.processBatch(batch, handler);
    expect(result.duplicates).toBe(2);
    expect(result.processed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Duplicate count metric / log
  // -------------------------------------------------------------------------

  it("emits a console.warn for each duplicate event", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const event = makeEvent("evt-dup", 300);

    await processor.processBatch([event], handler);
    await processor.processBatch([event], handler); // duplicate

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/duplicate/i);
    warnSpy.mockRestore();
  });

  it("getTotalDuplicates increments for every duplicate seen", async () => {
    const event = makeEvent("evt-1", 100);
    await processor.processBatch([event], handler);
    await processor.processBatch([event], handler);
    await processor.processBatch([event], handler);

    expect(processor.getTotalDuplicates()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Processing continues after duplicates
  // -------------------------------------------------------------------------

  it("continues processing new events after encountering duplicates", async () => {
    const first = makeEvent("evt-1", 100);
    const second = makeEvent("evt-2", 101);

    await processor.processBatch([first], handler);
    handler.mockClear();

    // Batch contains a duplicate followed by a new event
    const result = await processor.processBatch([first, second], handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(second);
    expect(result.processed).toBe(1);
    expect(result.duplicates).toBe(1);
  });

  it("processes all unique events even when duplicates are interspersed", async () => {
    const e1 = makeEvent("evt-1", 100);
    const e2 = makeEvent("evt-2", 100);
    const e3 = makeEvent("evt-3", 100);

    const batch = [e1, e2, e1, e3, e2]; // e1 and e2 duplicated
    const result = await processor.processBatch(batch, handler);

    expect(result.processed).toBe(3);
    expect(result.duplicates).toBe(2);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // Ledger replay scenario
  // -------------------------------------------------------------------------

  it("handles a full ledger replay without re-processing any event", async () => {
    const ledger100 = [
      makeEvent("evt-100-1", 100),
      makeEvent("evt-100-2", 100),
      makeEvent("evt-100-3", 100),
    ];

    // Initial processing
    await processor.processBatch(ledger100, handler);
    expect(handler).toHaveBeenCalledTimes(3);

    handler.mockClear();

    // Ledger replay — same events re-delivered
    const result = await processor.processBatch(ledger100, handler);

    expect(handler).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(result.duplicates).toBe(3);
    expect(processor.getTotalDuplicates()).toBe(3);
  });

  it("correctly processes new events from a later ledger after a replay", async () => {
    const ledger100 = [makeEvent("evt-100-1", 100)];
    const ledger101 = [makeEvent("evt-101-1", 101)];

    await processor.processBatch(ledger100, handler);
    await processor.processBatch(ledger100, handler); // replay ledger 100

    handler.mockClear();
    const result = await processor.processBatch(ledger101, handler);

    expect(result.processed).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(handler).toHaveBeenCalledWith(ledger101[0]);
  });

  // -------------------------------------------------------------------------
  // Handler failures do not block subsequent events
  // -------------------------------------------------------------------------

  it("continues processing after a handler failure and does not mark failed event as seen", async () => {
    const failing = makeEvent("evt-fail", 100);
    const succeeding = makeEvent("evt-ok", 100);

    const flakyHandler = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient error"))
      .mockResolvedValue(undefined) as MockInstance & ((event: IndexerEvent) => Promise<void>);

    const result = await processor.processBatch(
      [failing, succeeding],
      flakyHandler
    );

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.duplicates).toBe(0);

    // Failed event is NOT in seen set — can be retried
    expect(processor.getSeenCount()).toBe(1);
  });
});
