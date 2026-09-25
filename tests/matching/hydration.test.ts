/**
 * #449 — Restart simulation: order books hydrated from Postgres on cold start.
 *
 * Verifies that after a simulated API restart (books cleared), calling
 * hydrateAllActiveMarkets() re-loads OPEN/PARTIALLY_FILLED orders so the
 * in-memory depth matches the DB state — eliminating the race window.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  matchingService,
  getHydratedMarketsCount,
} from "../../src/matching/matching-service.js";

// ---------------------------------------------------------------------------
// Minimal Prisma mock — avoids a real DB connection
// ---------------------------------------------------------------------------

const mockMarkets = [{ id: "market-1" }, { id: "market-2" }];

const mockOrders = [
  {
    id: "order-1",
    userAddress: "GBUYER00000000000000000000000000000000000000000000000000",
    side: "BUY",
    outcome: "YES",
    price: { toString: () => "0.6" },
    quantity: 100,
    filledQuantity: 0,
    status: "OPEN",
    createdAt: new Date("2025-01-01T00:00:00Z"),
    marketId: "market-1",
  },
  {
    id: "order-2",
    userAddress: "GSELLER0000000000000000000000000000000000000000000000000",
    side: "SELL",
    outcome: "YES",
    price: { toString: () => "0.7" },
    quantity: 50,
    filledQuantity: 10,
    status: "PARTIALLY_FILLED",
    createdAt: new Date("2025-01-01T00:01:00Z"),
    marketId: "market-1",
  },
];

vi.mock("../../src/services/prisma.js", () => ({
  getPrismaClient: () => ({
    market: {
      findMany: vi.fn().mockImplementation(({ where }) => {
        if (where?.status === "ACTIVE") return Promise.resolve(mockMarkets);
        return Promise.resolve([]);
      }),
    },
    order: {
      findMany: vi.fn().mockImplementation(({ where }) => {
        // Return orders only for market-1 / YES
        if (where?.marketId === "market-1" && where?.outcome === "YES") {
          return Promise.resolve(mockOrders);
        }
        return Promise.resolve([]);
      }),
    },
  }),
}));

describe("#449 — hydrateAllActiveMarkets (restart simulation)", () => {
  beforeEach(() => {
    // Clear internal books to simulate a cold start
    // Access via private field through any-cast, same approach used by existing tests
    (matchingService as any).books.clear();
  });

  it("populates books for every active market after hydration", async () => {
    process.env.WARM_MARKETS_ON_STARTUP = "true";
    await matchingService.hydrateAllActiveMarkets();

    // Both markets × both outcomes = 4 book keys created
    const books: Map<string, unknown> = (matchingService as any).books;
    expect(books.size).toBe(4); // market-1:YES, market-1:NO, market-2:YES, market-2:NO
  });

  it("book depth matches DB orders after hydration", async () => {
    process.env.WARM_MARKETS_ON_STARTUP = "true";
    await matchingService.hydrateAllActiveMarkets();

    const book = (matchingService as any).books.get("market-1:YES");
    expect(book).toBeDefined();

    const depth = book.getDepth(10);

    // order-1: BUY 100 @ 0.6 → bid level
    expect(depth.bids).toHaveLength(1);
    expect(depth.bids[0].price).toBe(0.6);
    expect(depth.bids[0].quantity).toBe(100);

    // order-2: SELL 40 remaining @ 0.7 → ask level
    expect(depth.asks).toHaveLength(1);
    expect(depth.asks[0].price).toBe(0.7);
    expect(depth.asks[0].quantity).toBe(40); // 50 - 10 filled
  });

  it("records the hydrated_markets health metric", async () => {
    process.env.WARM_MARKETS_ON_STARTUP = "true";
    await matchingService.hydrateAllActiveMarkets();

    expect(getHydratedMarketsCount()).toBe(mockMarkets.length);
  });

  it("skips hydration when WARM_MARKETS_ON_STARTUP=false", async () => {
    process.env.WARM_MARKETS_ON_STARTUP = "false";
    await matchingService.hydrateAllActiveMarkets();

    const books: Map<string, unknown> = (matchingService as any).books;
    expect(books.size).toBe(0);
  });

  it("skips hydration when MATCHING_ENGINE_ENABLED=false (#744)", async () => {
    process.env.WARM_MARKETS_ON_STARTUP = "true";
    process.env.MATCHING_ENGINE_ENABLED = "false";
    try {
      await matchingService.hydrateAllActiveMarkets();

      const books: Map<string, unknown> = (matchingService as any).books;
      expect(books.size).toBe(0);
    } finally {
      delete process.env.MATCHING_ENGINE_ENABLED;
    }
  });

  it("books are empty before hydration (simulates cold restart)", () => {
    const books: Map<string, unknown> = (matchingService as any).books;
    expect(books.size).toBe(0);
  });

  it("does not clobber a book while a concurrent operation holds its mutex (#955)", async () => {
    // Regression test: hydrateBook() used to write `this.books.set(...)`
    // without ever acquiring the per-book mutex that placeOrder/cancelOrder
    // hold for the duration of a match. That let a re-hydration (e.g.
    // triggered by regaining the matching leader lease) read a DB snapshot
    // taken *before* a concurrent match's commit, then overwrite the book
    // the match had already mutated — reviving an already-filled order in
    // memory so the next taker could match (and fill) it a second time.
    process.env.WARM_MARKETS_ON_STARTUP = "true";
    const svc = matchingService as any;
    const bookKey = "market-1:YES";

    // Stand-in for a book a concurrent placeOrder has already mutated.
    const sentinelBook = {
      __sentinel: true,
      getDepth: () => ({ bids: [], asks: [] }),
    };
    svc.books.set(bookKey, sentinelBook);

    // Simulate placeOrder currently holding market-1:YES's mutex.
    let releaseHold: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const mutex = svc.getOrCreateMutex(bookKey);
    const holdPromise = mutex.run(() => held);

    const hydrationPromise = matchingService.hydrateAllActiveMarkets();

    // While the mutex is held, hydration must be queued, not applied.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(svc.books.get(bookKey)).toBe(sentinelBook);

    // Release the simulated in-flight operation.
    releaseHold();
    await holdPromise;
    await hydrationPromise;

    // Hydration proceeded only once the lock was free, and replaced the book.
    expect(svc.books.get(bookKey)).not.toBe(sentinelBook);
  });

  it("creates empty books for outcomes with no resting orders", async () => {
    process.env.WARM_MARKETS_ON_STARTUP = "true";
    await matchingService.hydrateAllActiveMarkets();

    const book = (matchingService as any).books.get("market-1:NO");
    expect(book).toBeDefined();

    const depth = book.getDepth(10);
    expect(depth.bids).toHaveLength(0);
    expect(depth.asks).toHaveLength(0);
  });
});
