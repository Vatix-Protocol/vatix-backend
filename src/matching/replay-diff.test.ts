import { describe, it, expect } from "vitest";
import { replayEvents, type ReplayEvent } from "./replay.js";
import {
  buildDivergenceReport,
  type LedgerOrder,
  type LedgerTrade,
} from "./replay-diff.js";

/**
 * Proves the acceptance criteria for the replay forensics tool:
 *  - replaying a known-consistent corpus yields zero diff
 *  - injected book corruption (bad filledQuantity, phantom order, wrong
 *    depth) is detected with clear order-id level output
 */
describe("buildDivergenceReport", () => {
  const marketId = "market-diff";
  const outcome = "YES" as const;

  function baseCorpus(): {
    events: ReplayEvent[];
    ledgerOrders: LedgerOrder[];
    ledgerTrades: LedgerTrade[];
  } {
    const events: ReplayEvent[] = [
      {
        type: "create",
        id: "maker-1",
        userAddress: "GMAKER00000000000000000000000000000000000000000001",
        side: "SELL",
        price: 0.4,
        quantity: 100,
        timestamp: 1_700_000_000_000,
      },
      {
        type: "create",
        id: "taker-1",
        userAddress: "GTAKER00000000000000000000000000000000000000000001",
        side: "BUY",
        price: 0.4,
        quantity: 60,
        timestamp: 1_700_000_001_000,
      },
    ];

    // Ground truth ledger: maker-1 partially filled (60/100), still resting;
    // taker-1 fully filled.
    const ledgerOrders: LedgerOrder[] = [
      {
        id: "maker-1",
        userAddress: "GMAKER00000000000000000000000000000000000000000001",
        side: "SELL",
        price: 0.4,
        quantity: 100,
        filledQuantity: 60,
        status: "PARTIALLY_FILLED",
      },
      {
        id: "taker-1",
        userAddress: "GTAKER00000000000000000000000000000000000000000001",
        side: "BUY",
        price: 0.4,
        quantity: 60,
        filledQuantity: 60,
        status: "FILLED",
      },
    ];

    const ledgerTrades: LedgerTrade[] = [
      {
        buyOrderId: "taker-1",
        sellOrderId: "maker-1",
        quantity: 60,
        price: 0.4,
      },
    ];

    return { events, ledgerOrders, ledgerTrades };
  }

  it("reports zero diff for a consistent corpus", () => {
    const { events, ledgerOrders, ledgerTrades } = baseCorpus();
    const replay = replayEvents(marketId, outcome, events);

    const report = buildDivergenceReport({
      marketId,
      outcome,
      asOf: new Date(),
      ledgerOrders,
      ledgerTrades,
      replay,
    });

    expect(report.hasDivergence).toBe(false);
    expect(report.orderMismatches).toEqual([]);
    expect(report.missingOrderIds).toEqual([]);
    expect(report.extraOrderIds).toEqual([]);
    expect(report.missingTrades).toEqual([]);
    expect(report.extraTrades).toEqual([]);
  });

  it("detects a filledQuantity accounting bug with order-id level output", () => {
    const { events, ledgerOrders, ledgerTrades } = baseCorpus();
    const replay = replayEvents(marketId, outcome, events);

    // Corrupt the ledger: pretend maker-1's filledQuantity was recorded wrong
    // (e.g. a double-counted fill never actually applied by the engine).
    const corruptedOrders = ledgerOrders.map((o) =>
      o.id === "maker-1" ? { ...o, filledQuantity: 90 } : o
    );

    const report = buildDivergenceReport({
      marketId,
      outcome,
      asOf: new Date(),
      ledgerOrders: corruptedOrders,
      ledgerTrades,
      replay,
    });

    expect(report.hasDivergence).toBe(true);
    expect(report.orderMismatches).toContainEqual({
      orderId: "maker-1",
      field: "filledQuantity",
      expected: 90,
      actual: 60,
    });
    expect(report.orderMismatches).toContainEqual({
      orderId: "maker-1",
      field: "remaining",
      expected: 10,
      actual: 40,
    });
  });

  it("detects a phantom order missing from the ledger", () => {
    const { events, ledgerOrders, ledgerTrades } = baseCorpus();
    const replay = replayEvents(marketId, outcome, events);

    // Drop maker-1 from the ledger entirely, as if its DB row vanished
    // while the engine still resurrected it into the book.
    const withoutMaker = ledgerOrders.filter((o) => o.id !== "maker-1");

    const report = buildDivergenceReport({
      marketId,
      outcome,
      asOf: new Date(),
      ledgerOrders: withoutMaker,
      ledgerTrades,
      replay,
    });

    expect(report.hasDivergence).toBe(true);
    expect(report.extraOrderIds).toEqual(["maker-1"]);
  });

  it("detects a resting order missing from the replayed book", () => {
    const { ledgerOrders, ledgerTrades } = baseCorpus();
    // Replay only the taker event, never adding maker-1 to the book at all
    // (simulating a hydration bug that dropped a resting order).
    const replay = replayEvents(marketId, outcome, [
      {
        type: "create",
        id: "taker-1",
        userAddress: "GTAKER00000000000000000000000000000000000000000001",
        side: "BUY",
        price: 0.4,
        quantity: 60,
        timestamp: 1_700_000_001_000,
      },
    ]);

    const report = buildDivergenceReport({
      marketId,
      outcome,
      asOf: new Date(),
      ledgerOrders,
      ledgerTrades,
      replay,
    });

    expect(report.hasDivergence).toBe(true);
    expect(report.missingOrderIds).toEqual(["maker-1"]);
    // taker-1 never matches without maker-1 resting, so the recorded trade
    // never gets reproduced either.
    expect(report.missingTrades).toHaveLength(1);
  });

  it("detects a price-level depth mismatch against the Redis snapshot", () => {
    const { events, ledgerOrders, ledgerTrades } = baseCorpus();
    const replay = replayEvents(marketId, outcome, events);

    const report = buildDivergenceReport({
      marketId,
      outcome,
      asOf: new Date(),
      ledgerOrders,
      ledgerTrades,
      replay,
      // Redis cache stale: reports 25 resting at 0.4 instead of the true 40.
      redisSnapshot: { bids: [], asks: [{ price: 0.4, quantity: 25 }] },
    });

    expect(report.hasDivergence).toBe(true);
    expect(report.depthDeltas).toContainEqual({
      side: "ask",
      price: 0.4,
      expectedQuantity: 25,
      actualQuantity: 40,
    });
  });
});
