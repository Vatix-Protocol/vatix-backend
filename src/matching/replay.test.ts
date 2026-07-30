import { describe, it, expect, vi, afterEach } from "vitest";
import { matchOrder, type MatchingOrder } from "./engine.js";
import { OrderBook, type Order as BookOrder } from "./orderbook.js";
import { replayEvents, type ReplayEvent } from "./replay.js";

/**
 * Golden replay corpus (forensics): proves `replayEvents` — the pure
 * function driving scripts/replay-market.ts — reproduces byte-identical
 * trades to directly driving `matchOrder`/`OrderBook`, for the same fill
 * scenarios as the #729 snapshot corpus in engine.fills.snapshot.test.ts.
 *
 * `matchOrder` stamps trades with `Date.now()`, so it's frozen per taker
 * event just like the existing snapshot corpus.
 */
describe("replayEvents (golden corpus, replay equals live engine output)", () => {
  const marketId = "market-replay";
  const outcome = "YES" as const;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fully fills a taker order against a single resting maker", () => {
    const makerTs = 1_700_000_000_000;
    const takerTs = 1_700_000_001_000;

    const events: ReplayEvent[] = [
      {
        type: "create",
        id: "maker-1",
        userAddress: "GMAKER00000000000000000000000000000000000000000001",
        side: "SELL",
        price: 0.5,
        quantity: 100,
        timestamp: makerTs,
      },
      {
        type: "create",
        id: "taker-1",
        userAddress: "GTAKER00000000000000000000000000000000000000000001",
        side: "BUY",
        price: 0.5,
        quantity: 100,
        timestamp: takerTs,
      },
    ];

    vi.spyOn(Date, "now").mockReturnValue(takerTs);
    const replayResult = replayEvents(marketId, outcome, events);

    // Directly drive the live engine the same way matching-service.ts does.
    const liveBook = new OrderBook(marketId, 0);
    liveBook.addOrder(
      bookOrder(
        "maker-1",
        "GMAKER00000000000000000000000000000000000000000001",
        "ask",
        0.5,
        100,
        makerTs
      )
    );
    vi.spyOn(Date, "now").mockReturnValue(takerTs);
    const liveResult = matchOrder(
      matchingOrder(
        "taker-1",
        "GTAKER00000000000000000000000000000000000000000001",
        "BUY",
        0.5,
        100,
        takerTs
      ),
      liveBook
    );

    expect(replayResult.trades).toEqual(liveResult.trades);
    expect(replayResult.book.getOrderCount()).toBe(liveBook.getOrderCount());
    expect(replayResult.orders.get("maker-1")?.remaining).toBe(0);
    expect(replayResult.orders.get("taker-1")?.remaining).toBe(0);
  });

  it("partially fills a taker order and leaves a remaining resting order", () => {
    const makerTs = 1_700_000_000_000;
    const takerTs = 1_700_000_001_000;

    const events: ReplayEvent[] = [
      {
        type: "create",
        id: "maker-1",
        userAddress: "GMAKER00000000000000000000000000000000000000000002",
        side: "SELL",
        price: 0.45,
        quantity: 40,
        timestamp: makerTs,
      },
      {
        type: "create",
        id: "taker-1",
        userAddress: "GTAKER00000000000000000000000000000000000000000002",
        side: "BUY",
        price: 0.5,
        quantity: 100,
        timestamp: takerTs,
      },
    ];

    vi.spyOn(Date, "now").mockReturnValue(takerTs);
    const replayResult = replayEvents(marketId, outcome, events);

    const liveBook = new OrderBook(marketId, 0);
    liveBook.addOrder(
      bookOrder(
        "maker-1",
        "GMAKER00000000000000000000000000000000000000000002",
        "ask",
        0.45,
        40,
        makerTs
      )
    );
    vi.spyOn(Date, "now").mockReturnValue(takerTs);
    const liveResult = matchOrder(
      matchingOrder(
        "taker-1",
        "GTAKER00000000000000000000000000000000000000000002",
        "BUY",
        0.5,
        100,
        takerTs
      ),
      liveBook
    );

    expect(replayResult.trades).toEqual(liveResult.trades);
    expect(replayResult.orders.get("maker-1")?.remaining).toBe(0);
    expect(replayResult.orders.get("taker-1")?.remaining).toBe(60);
    expect(replayResult.book.getOrderCount()).toBe(1); // taker's remainder rests
  });

  it("a cancelled maker is excluded from later matches", () => {
    const maker1Ts = 1_700_000_000_000;
    const maker2Ts = 1_700_000_000_500;
    const cancelTs = 1_700_000_000_800;
    const takerTs = 1_700_000_001_000;

    const events: ReplayEvent[] = [
      {
        type: "create",
        id: "maker-1",
        userAddress: "GMAKER00000000000000000000000000000000000000000003",
        side: "SELL",
        price: 0.5,
        quantity: 50,
        timestamp: maker1Ts,
      },
      {
        type: "create",
        id: "maker-2",
        userAddress: "GMAKER00000000000000000000000000000000000000000004",
        side: "SELL",
        price: 0.5,
        quantity: 50,
        timestamp: maker2Ts,
      },
      { type: "cancel", id: "maker-1", timestamp: cancelTs },
      {
        type: "create",
        id: "taker-1",
        userAddress: "GTAKER00000000000000000000000000000000000000000003",
        side: "BUY",
        price: 0.5,
        quantity: 50,
        timestamp: takerTs,
      },
    ];

    vi.spyOn(Date, "now").mockReturnValue(takerTs);
    const replayResult = replayEvents(marketId, outcome, events);

    expect(replayResult.trades).toHaveLength(1);
    expect(replayResult.trades[0].sellOrderId).toBe("maker-2");
    expect(replayResult.orders.get("maker-1")?.remaining).toBe(50); // never filled, just cancelled
    expect(replayResult.book.getOrdersAtPrice("ask", 0.5)).toHaveLength(0);
  });

  it("skips a self-trade and matches the next resting order at the same price", () => {
    const sameUser = "GSAMEUSER0000000000000000000000000000000000000001";
    const selfTs = 1_700_000_000_000;
    const makerTs = 1_700_000_000_500;
    const takerTs = 1_700_000_001_000;

    const events: ReplayEvent[] = [
      {
        type: "create",
        id: "self-1",
        userAddress: sameUser,
        side: "SELL",
        price: 0.5,
        quantity: 100,
        timestamp: selfTs,
      },
      {
        type: "create",
        id: "maker-1",
        userAddress: "GMAKER00000000000000000000000000000000000000000006",
        side: "SELL",
        price: 0.5,
        quantity: 100,
        timestamp: makerTs,
      },
      {
        type: "create",
        id: "taker-1",
        userAddress: sameUser,
        side: "BUY",
        price: 0.5,
        quantity: 100,
        timestamp: takerTs,
      },
    ];

    vi.spyOn(Date, "now").mockReturnValue(takerTs);
    const replayResult = replayEvents(marketId, outcome, events);

    expect(replayResult.trades).toHaveLength(1);
    expect(replayResult.trades[0].sellOrderId).toBe("maker-1");
    expect(replayResult.book.getOrderCount()).toBe(0);
  });
});

function bookOrder(
  id: string,
  userAddress: string,
  side: "bid" | "ask",
  price: number,
  quantity: number,
  timestamp: number
): BookOrder {
  return {
    id,
    userAddress,
    side,
    price,
    quantity,
    timestamp,
    marketId: "market-replay",
    outcome: 0,
  };
}

function matchingOrder(
  id: string,
  userAddress: string,
  side: "BUY" | "SELL",
  price: number,
  quantity: number,
  timestamp: number
): MatchingOrder {
  return {
    id,
    userAddress,
    side,
    price,
    quantity,
    marketId: "market-replay",
    outcome: "YES",
    timestamp,
  };
}
