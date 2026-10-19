import { describe, it, expect, vi, afterEach } from "vitest";
import { replayEvents, type ReplayEvent } from "./replay.js";
import { OrderBook } from "./orderbook.js";
import { matchOrder, type MatchingOrder } from "./engine.js";
import type { OrderSide, Outcome } from "../types/index.js";

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
