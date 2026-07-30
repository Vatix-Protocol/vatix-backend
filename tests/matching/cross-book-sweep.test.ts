import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { matchOrder, MatchingOrder } from "../../src/matching/engine.js";
import { OrderBook, Order as BookOrder } from "../../src/matching/orderbook.js";

/**
 * Cross-book sweep fill scenarios (#808, ties to #729).
 *
 * A market maintains one independent OrderBook per outcome (YES/NO, keyed
 * as `marketId:outcome`). These scenarios assert that a taker sweep in one
 * outcome's book never leaks trades/state into the sibling outcome's book
 * for the same market — matching stays scoped per-book even when both
 * books are swept in the same test run.
 */
describe("cross-book sweep fill scenarios (snapshots)", () => {
  const FIXED_NOW = 1_700_000_000_000;
  const marketId = "market-cross-book";

  let yesBook: OrderBook;
  let noBook: OrderBook;

  const createBookOrder = (
    id: string,
    side: "bid" | "ask",
    price: number,
    quantity: number,
    timestamp: number,
    userAddress: string,
    outcome: number
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
    userAddress: string,
    outcome: "YES" | "NO"
  ): MatchingOrder => ({
    id,
    userAddress,
    side,
    price,
    quantity,
    marketId,
    outcome,
    timestamp: FIXED_NOW,
  });

  beforeEach(() => {
    yesBook = new OrderBook(marketId, 0);
    noBook = new OrderBook(marketId, 1);
    vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sweeps the YES book across price levels while the NO book stays untouched", () => {
    yesBook.addOrder(
      createBookOrder("yes-maker-1", "ask", 0.4, 30, FIXED_NOW - 3000, "GMAKERY001", 0)
    );
    yesBook.addOrder(
      createBookOrder("yes-maker-2", "ask", 0.45, 50, FIXED_NOW - 2000, "GMAKERY002", 0)
    );
    noBook.addOrder(
      createBookOrder("no-maker-1", "ask", 0.55, 100, FIXED_NOW - 1000, "GMAKERN001", 1)
    );

    const taker = createMatchingOrder("taker-yes-1", "BUY", 0.45, 70, "GTAKERY001", "YES");
    const result = matchOrder(taker, yesBook);

    expect(result).toMatchSnapshot();
    expect(noBook.getOrderCount()).toBe(1);
    expect(noBook.getDepth(10).asks[0].price).toBe(0.55);
  });

  it("sweeps the NO book across price levels while the YES book stays untouched", () => {
    noBook.addOrder(
      createBookOrder("no-maker-1", "ask", 0.3, 20, FIXED_NOW - 3000, "GMAKERN010", 1)
    );
    noBook.addOrder(
      createBookOrder("no-maker-2", "ask", 0.35, 60, FIXED_NOW - 2000, "GMAKERN011", 1)
    );
    yesBook.addOrder(
      createBookOrder("yes-maker-1", "ask", 0.6, 100, FIXED_NOW - 1000, "GMAKERY010", 0)
    );

    const taker = createMatchingOrder("taker-no-1", "BUY", 0.35, 65, "GTAKERN010", "NO");
    const result = matchOrder(taker, noBook);

    expect(result).toMatchSnapshot();
    expect(yesBook.getOrderCount()).toBe(1);
    expect(yesBook.getDepth(10).asks[0].price).toBe(0.6);
  });

  it("independently sweeps both YES and NO books for the same market in one run", () => {
    yesBook.addOrder(
      createBookOrder("yes-maker-1", "ask", 0.5, 40, FIXED_NOW - 2000, "GMAKERY020", 0)
    );
    yesBook.addOrder(
      createBookOrder("yes-maker-2", "ask", 0.55, 40, FIXED_NOW - 1000, "GMAKERY021", 0)
    );
    noBook.addOrder(
      createBookOrder("no-maker-1", "ask", 0.42, 40, FIXED_NOW - 2000, "GMAKERN020", 1)
    );
    noBook.addOrder(
      createBookOrder("no-maker-2", "ask", 0.48, 40, FIXED_NOW - 1000, "GMAKERN021", 1)
    );

    const yesTaker = createMatchingOrder("taker-yes-2", "BUY", 0.55, 60, "GTAKERY020", "YES");
    const noTaker = createMatchingOrder("taker-no-2", "BUY", 0.48, 60, "GTAKERN020", "NO");

    const yesResult = matchOrder(yesTaker, yesBook);
    const noResult = matchOrder(noTaker, noBook);

    expect({ yesResult, noResult }).toMatchSnapshot();
    // Each book only ever produced trades scoped to its own outcome.
    expect(yesResult.trades.every((t) => t.outcome === "YES")).toBe(true);
    expect(noResult.trades.every((t) => t.outcome === "NO")).toBe(true);
  });
});
