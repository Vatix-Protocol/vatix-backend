import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { matchOrder, MatchingOrder } from "./engine.js";
import { OrderBook, Order as BookOrder } from "./orderbook.js";

/**
 * Snapshot corpus for matching engine fill scenarios (#729).
 *
 * `matchOrder` stamps trades with `Date.now()`, so `Date.now` is frozen for
 * every scenario below to keep snapshots stable across runs and machines.
 */
describe("matchOrder fill scenarios (snapshots)", () => {
  const FIXED_NOW = 1_700_000_000_000;
  const marketId = "market-snap";
  const outcome = 0; // YES

  let orderBook: OrderBook;

  const createBookOrder = (
    id: string,
    side: "bid" | "ask",
    price: number,
    quantity: number,
    timestamp: number,
    userAddress: string
  ): BookOrder => ({
    id,
    userAddress,
    side,
    price,
    quantity,
    timestamp,
    marketId,
    outcome,
  });

  const createMatchingOrder = (
    id: string,
    side: "BUY" | "SELL",
    price: number,
    quantity: number,
    userAddress: string
  ): MatchingOrder => ({
    id,
    userAddress,
    side,
    price,
    quantity,
    marketId,
    outcome: "YES",
    timestamp: FIXED_NOW,
  });

  beforeEach(() => {
    orderBook = new OrderBook(marketId, outcome);
    vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fully fills a taker order against a single resting maker", () => {
    orderBook.addOrder(
      createBookOrder(
        "maker-1",
        "ask",
        0.5,
        100,
        FIXED_NOW - 1000,
        "GMAKER00000000000000000000000000000000000000000001"
      )
    );

    const taker = createMatchingOrder(
      "taker-1",
      "BUY",
      0.5,
      100,
      "GTAKER00000000000000000000000000000000000000000001"
    );

    const result = matchOrder(taker, orderBook);

    expect(result).toMatchSnapshot();
  });

  it("partially fills a taker order and leaves a remaining resting order", () => {
    orderBook.addOrder(
      createBookOrder(
        "maker-1",
        "ask",
        0.45,
        40,
        FIXED_NOW - 1000,
        "GMAKER00000000000000000000000000000000000000000002"
      )
    );

    const taker = createMatchingOrder(
      "taker-1",
      "BUY",
      0.5,
      100,
      "GTAKER00000000000000000000000000000000000000000002"
    );

    const result = matchOrder(taker, orderBook);

    expect(result).toMatchSnapshot();
  });

  it("sweeps multiple price levels in price-time priority", () => {
    orderBook.addOrder(
      createBookOrder(
        "maker-1",
        "ask",
        0.4,
        30,
        FIXED_NOW - 3000,
        "GMAKER00000000000000000000000000000000000000000003"
      )
    );
    orderBook.addOrder(
      createBookOrder(
        "maker-2",
        "ask",
        0.45,
        50,
        FIXED_NOW - 2000,
        "GMAKER00000000000000000000000000000000000000000004"
      )
    );
    orderBook.addOrder(
      createBookOrder(
        "maker-3",
        "ask",
        0.5,
        50,
        FIXED_NOW - 1000,
        "GMAKER00000000000000000000000000000000000000000005"
      )
    );

    const taker = createMatchingOrder(
      "taker-1",
      "BUY",
      0.5,
      90,
      "GTAKER00000000000000000000000000000000000000000003"
    );

    const result = matchOrder(taker, orderBook);

    expect(result).toMatchSnapshot();
  });

  it("skips a self-trade and matches the next resting order at the same price", () => {
    const sameUser = "GSAMEUSER0000000000000000000000000000000000000001";

    orderBook.addOrder(
      createBookOrder("self-1", "ask", 0.5, 100, FIXED_NOW - 2000, sameUser)
    );
    orderBook.addOrder(
      createBookOrder(
        "maker-1",
        "ask",
        0.5,
        100,
        FIXED_NOW - 1000,
        "GMAKER00000000000000000000000000000000000000000006"
      )
    );

    const taker = createMatchingOrder("taker-1", "BUY", 0.5, 100, sameUser);

    const result = matchOrder(taker, orderBook);

    expect(result).toMatchSnapshot();
    // The self-trade order must be removed from the book without producing a trade,
    // and the taker must match the next resting order instead.
    expect(result.trades[0].sellOrderId).toBe("maker-1");
    expect(orderBook.getOrderCount()).toBe(0);
  });

  it("breaks ties at an identical price level by time priority (FIFO)", () => {
    // Three makers all resting at the same price — the earliest-timestamp
    // (first-inserted) maker must fill first, then the second, leaving the
    // last maker resting. This isolates the *time* half of price-time
    // priority, which the multi-level sweep test above does not exercise.
    orderBook.addOrder(
      createBookOrder(
        "maker-earliest",
        "ask",
        0.5,
        30,
        FIXED_NOW - 3000,
        "GMAKER00000000000000000000000000000000000000000008"
      )
    );
    orderBook.addOrder(
      createBookOrder(
        "maker-middle",
        "ask",
        0.5,
        30,
        FIXED_NOW - 2000,
        "GMAKER00000000000000000000000000000000000000000009"
      )
    );
    orderBook.addOrder(
      createBookOrder(
        "maker-latest",
        "ask",
        0.5,
        30,
        FIXED_NOW - 1000,
        "GMAKER00000000000000000000000000000000000000000010"
      )
    );

    const taker = createMatchingOrder(
      "taker-1",
      "BUY",
      0.5,
      50,
      "GTAKER00000000000000000000000000000000000000000005"
    );

    const result = matchOrder(taker, orderBook);

    expect(result).toMatchSnapshot();
    expect(result.trades.map((t) => t.sellOrderId)).toEqual([
      "maker-earliest",
      "maker-middle",
    ]);
    // maker-earliest (30) fills fully, maker-middle (30) fills partially (20 of
    // 30, taker had 20 left) and — being a quantity update, not a re-insert —
    // keeps its FIFO position ahead of the untouched maker-latest.
    const remaining = orderBook.getOrdersAtPrice("ask", 0.5);
    expect(remaining.map((o) => [o.id, o.quantity])).toEqual([
      ["maker-middle", 10],
      ["maker-latest", 30],
    ]);
  });

  it("sweeps multiple bid price levels for a SELL taker (opposite-side cross-book sweep)", () => {
    // Mirrors the BUY-taker sweep above, but from the other side of the
    // book, to confirm cross-book sweep coverage isn't asymmetric.
    orderBook.addOrder(
      createBookOrder(
        "maker-bid-1",
        "bid",
        0.6,
        30,
        FIXED_NOW - 3000,
        "GMAKER00000000000000000000000000000000000000000011"
      )
    );
    orderBook.addOrder(
      createBookOrder(
        "maker-bid-2",
        "bid",
        0.55,
        50,
        FIXED_NOW - 2000,
        "GMAKER00000000000000000000000000000000000000000012"
      )
    );
    orderBook.addOrder(
      createBookOrder(
        "maker-bid-3",
        "bid",
        0.5,
        50,
        FIXED_NOW - 1000,
        "GMAKER00000000000000000000000000000000000000000013"
      )
    );

    const taker = createMatchingOrder(
      "taker-1",
      "SELL",
      0.5,
      90,
      "GTAKER00000000000000000000000000000000000000000006"
    );

    const result = matchOrder(taker, orderBook);

    expect(result).toMatchSnapshot();
    // Best bid (highest price) fills first: 0.60, then 0.55, then partially 0.50.
    expect(result.trades.map((t) => t.price)).toEqual([0.6, 0.55, 0.5]);
    expect(result.trades.map((t) => t.quantity)).toEqual([30, 50, 10]);
  });

  it("returns no trades and the original order unchanged when nothing crosses", () => {
    orderBook.addOrder(
      createBookOrder(
        "maker-1",
        "ask",
        0.6,
        100,
        FIXED_NOW - 1000,
        "GMAKER00000000000000000000000000000000000000000007"
      )
    );

    const taker = createMatchingOrder(
      "taker-1",
      "BUY",
      0.5,
      100,
      "GTAKER00000000000000000000000000000000000000000004"
    );

    const result = matchOrder(taker, orderBook);

    expect(result).toMatchSnapshot();
  });
});
