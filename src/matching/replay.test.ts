import { describe, it, expect, vi, afterEach } from "vitest";
import { replayEvents, type ReplayEvent } from "./replay.js";
import { OrderBook } from "./orderbook.js";
import { matchOrder, type MatchingOrder } from "./engine.js";
import type { OrderSide, Outcome } from "../types/index.js";

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

  it("removes a cancelled order from the replay book and zeroes its remaining", () => {
    const makerTs = 1_700_000_000_000;
    const cancelTs = 1_700_000_000_500;

    const events: ReplayEvent[] = [
      {
        type: "create",
        id: "maker-1",
        userAddress: "GMAKER00000000000000000000000000000000000000000007",
        side: "SELL",
        price: 0.5,
        quantity: 50,
        timestamp: makerTs,
      },
      { type: "cancel", id: "maker-1", timestamp: cancelTs },
    ];

    const replayResult = replayEvents(marketId, outcome, events);

    // The cancelled order must be gone from the replay book.
    expect(replayResult.book.getOrderCount()).toBe(0);
    expect(replayResult.book.getOrdersAtPrice("ask", 0.5)).toHaveLength(0);
    // Its bookkeeping entry reflects the cancellation (remaining 0 or removed).
    const cancelled = replayResult.orders.get("maker-1");
    if (cancelled !== undefined) {
      expect(cancelled.remaining).toBe(0);
    } else {
      expect(cancelled).toBeUndefined();
    }
  });

  it("records a no-op for a cancel referencing an unknown order id", () => {
    const makerTs = 1_700_000_000_000;
    const cancelTs = 1_700_000_000_500;

    const events: ReplayEvent[] = [
      {
        type: "create",
        id: "maker-1",
        userAddress: "GMAKER00000000000000000000000000000000000000000008",
        side: "SELL",
        price: 0.5,
        quantity: 50,
        timestamp: makerTs,
      },
      { type: "cancel", id: "ghost-order", timestamp: cancelTs },
    ];

    // Documented behaviour: an unknown-id cancel is a recorded no-op, not a
    // silent swallow and not a crash. The known order is untouched.
    const replayResult = replayEvents(marketId, outcome, events);

    expect(replayResult.book.getOrderCount()).toBe(1);
    expect(replayResult.orders.get("maker-1")?.remaining).toBe(50);
    expect(replayResult.orders.has("ghost-order")).toBe(false);
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
  side: OrderSide,
  price: number,
  quantity: number,
  marketId = "market-1",
  outcome: Outcome = "YES",
  timestamp = 1_000
) {
  return {
    id,
    userAddress,
    side,
    price,
    quantity,
    marketId,
    outcome,
    timestamp,
  };
}

function matchingOrder(
  id: string,
  userAddress: string,
  side: OrderSide,
  price: number,
  quantity: number,
  marketId = "market-1",
  outcome: Outcome = "YES",
  timestamp = 1_000
): MatchingOrder {
  return {
    id,
    userAddress,
    side,
    price,
    quantity,
    marketId,
    outcome,
    timestamp,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("replayEvents", () => {
  it("reproduces a single-maker full fill", () => {
    const events: ReplayEvent[] = [
      {
        type: "create",
        order: bookOrder("maker-1", "0xmaker", "SELL", 100, 10),
      },
      {
        type: "create",
        order: bookOrder("taker-1", "0xtaker", "BUY", 100, 10),
      },
    ];

    const replayResult = replayEvents(events);

    const liveBook = new OrderBook();
    liveBook.addOrder(bookOrder("maker-1", "0xmaker", "SELL", 100, 10));
    const liveResult = matchOrder(
      matchingOrder("taker-1", "0xtaker", "BUY", 100, 10),
      liveBook
    );

    expect(replayResult.trades).toEqual(liveResult.trades);
    expect(replayResult.trades).toHaveLength(1);
  });

  it("reproduces a partial fill with a resting remainder", () => {
    const events: ReplayEvent[] = [
      {
        type: "create",
        order: bookOrder("maker-1", "0xmaker", "SELL", 100, 5),
      },
      {
        type: "create",
        order: bookOrder("taker-1", "0xtaker", "BUY", 100, 10),
      },
    ];

    const replayResult = replayEvents(events);

    const liveBook = new OrderBook();
    liveBook.addOrder(bookOrder("maker-1", "0xmaker", "SELL", 100, 5));
    const liveResult = matchOrder(
      matchingOrder("taker-1", "0xtaker", "BUY", 100, 10),
      liveBook
    );

    expect(replayResult.trades).toEqual(liveResult.trades);
    expect(replayResult.trades).toHaveLength(1);
    expect(replayResult.trades[0].quantity).toBe(5);
  });

  it("excludes a cancelled maker from later matches", () => {
    const events: ReplayEvent[] = [
      {
        type: "create",
        order: bookOrder("maker-1", "0xmaker", "SELL", 100, 10),
      },
      { type: "cancel", orderId: "maker-1" },
      {
        type: "create",
        order: bookOrder("taker-1", "0xtaker", "BUY", 100, 10),
      },
    ];

    const replayResult = replayEvents(events);

    const liveBook = new OrderBook();
    liveBook.addOrder(bookOrder("maker-1", "0xmaker", "SELL", 100, 10));
    liveBook.removeOrder("maker-1");
    const liveResult = matchOrder(
      matchingOrder("taker-1", "0xtaker", "BUY", 100, 10),
      liveBook
    );

    expect(replayResult.trades).toEqual(liveResult.trades);
    expect(replayResult.trades).toHaveLength(0);
  });

  it("reproduces a multi-maker sweep with book state and remaining quantities", () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const events: ReplayEvent[] = [
      {
        type: "create",
        order: bookOrder("maker-1", "0xmaker1", "SELL", 100, 5),
      },
      {
        type: "create",
        order: bookOrder("maker-2", "0xmaker2", "SELL", 101, 5),
      },
      {
        type: "create",
        order: bookOrder("maker-3", "0xmaker3", "SELL", 102, 5),
      },
      {
        type: "create",
        order: bookOrder("taker-1", "0xtaker", "BUY", 102, 12),
      },
    ];

    const replayResult = replayEvents(events);

    const liveBook = new OrderBook();
    liveBook.addOrder(bookOrder("maker-1", "0xmaker1", "SELL", 100, 5));
    liveBook.addOrder(bookOrder("maker-2", "0xmaker2", "SELL", 101, 5));
    liveBook.addOrder(bookOrder("maker-3", "0xmaker3", "SELL", 102, 5));
    const liveResult = matchOrder(
      matchingOrder("taker-1", "0xtaker", "BUY", 102, 12),
      liveBook
    );

    // Trade count and per-trade price/quantity.
    expect(replayResult.trades).toHaveLength(3);
    expect(replayResult.trades).toEqual(liveResult.trades);
    expect(replayResult.trades.map((t) => [t.price, t.quantity])).toEqual([
      [100, 5],
      [101, 5],
      [102, 2],
    ]);

    // Book order count matches the live engine.
    expect(replayResult.book.getOrderCount()).toBe(liveBook.getOrderCount());
    expect(replayResult.book.getOrderCount()).toBe(1);

    // Fully consumed makers are gone; the taker's remainder rests.
    const remainingById = new Map(
      replayResult.orders.map((o) => [o.id, o.quantity])
    );
    expect(remainingById.get("maker-1")).toBeUndefined();
    expect(remainingById.get("maker-2")).toBeUndefined();
    expect(remainingById.get("maker-3")).toBe(3);
    expect(remainingById.get("taker-1")).toBeUndefined();

    // The taker's remainder matches the live engine's remaining order.
    expect(liveResult.remainingOrder?.quantity).toBe(0);
    expect(replayResult.book.getBestAsk()?.id).toBe("maker-3");
    expect(replayResult.book.getBestAsk()?.quantity).toBe(3);
  });
});
