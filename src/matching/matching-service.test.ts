import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ValidationError,
  ServiceUnavailableError,
  MatchingUnavailableError,
  MarketNotActiveError,
  MarketNotFoundError,
  OrderConflictError,
} from "../api/middleware/errors.js";

// Mock dependencies
// Default to "we are the leader" so every pre-existing placeOrder test below
// keeps exercising the matching path unchanged; leader-lease.test.ts covers
// the LeaderLease class itself, this file only covers the placeOrder gate.
const leaderLeaseMock = vi.hoisted(() => ({
  isLeader: vi.fn(() => true),
}));
vi.mock("./leader-lease.js", () => ({ leaderLease: leaderLeaseMock }));

vi.mock("../services/prisma.js", () => ({
  getPrismaClient: () => mockPrismaClient,
}));

vi.mock("../services/audit.js", () => ({
  auditService: {
    logOrderMatch: vi.fn().mockResolvedValue("mock-entry-id"),
  },
}));

vi.mock("../services/settlement-queue.js", () => ({
  settlementQueue: {
    enqueue: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../services/redis.js", () => ({
  redis: {
    setOrderBook: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("./mutex.js", () => {
  return {
    Mutex: vi.fn().mockImplementation(function (this: any) {
      this.run = vi.fn((fn: () => Promise<any>) => fn());
    }),
  };
});

vi.mock("./engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine.js")>();
  return {
    ...actual,
    matchOrder: vi.fn(() => ({
      trades: [],
      remainingOrder: null,
      positionDeltas: [],
    })),
  };
});

// Mock prisma client
const mockTx = {
  order: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  trade: {
    upsert: vi.fn(),
  },
  outboxEvent: {
    upsert: vi.fn(),
  },
  userPosition: {
    findUnique: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
};

const mockPrismaClient = {
  order: {
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
  },
  market: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  userPosition: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  outboxEvent: {
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  $transaction: vi.fn((cb: (tx: any) => Promise<any>) => cb(mockTx)),
};

import {
  matchingService,
  isMatchingEngineEnabled,
} from "./matching-service.js";
import { matchOrder } from "./engine.js";
import { orderbookHydratedMarketsGauge } from "../services/metrics.js";

describe("MatchingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    leaderLeaseMock.isLeader.mockReturnValue(true);
    (matchingService as any).books?.clear();
    (matchingService as any).mutexes?.clear();
    mockPrismaClient.$transaction.mockImplementation(
      (cb: (tx: any) => Promise<any>) => cb(mockTx)
    );
    // Default: conditional updates succeed (one row affected). Individual
    // tests override this to simulate a version/status conflict.
    mockTx.order.updateMany.mockResolvedValue({ count: 1 });
  });

  describe("cancelOrder", () => {
    const now = new Date();
    const sampleOrder = {
      id: "order-1",
      marketId: "market-1",
      userAddress: "GUSER1234567890123456789012345678901234567890123456",
      side: "BUY",
      outcome: "YES",
      price: "0.5",
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
      version: 0,
      createdAt: now,
    };

    beforeEach(() => {
      // Outer (non-transactional) pre-read used to pick the per-book mutex
      // before entering the transaction (#866).
      mockPrismaClient.order.findUnique.mockResolvedValue({
        marketId: sampleOrder.marketId,
        outcome: sampleOrder.outcome,
      });
    });

    it("should cancel an OPEN order and release collateral", async () => {
      mockTx.order.findUnique.mockResolvedValue(sampleOrder);
      mockTx.userPosition.findUnique.mockResolvedValue({
        marketId: "market-1",
        userAddress: sampleOrder.userAddress,
        lockedCollateral: "50",
      });

      const result = await matchingService.cancelOrder(
        "order-1",
        sampleOrder.userAddress
      );

      expect(result.status).toBe("CANCELLED");
      expect(mockTx.order.findUnique).toHaveBeenCalledWith({
        where: { id: "order-1" },
      });
      // Conditional cancel: guarded on the version/status just read.
      expect(mockTx.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: "order-1",
          version: 0,
          status: { in: ["OPEN", "PARTIALLY_FILLED"] },
        },
        data: { status: "CANCELLED", version: { increment: 1 } },
      });
      // Collateral should be released: 100 * 0.5 = 50, so locked goes from 50 to 0
      expect(mockTx.userPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            marketId_userAddress: {
              marketId: "market-1",
              userAddress: sampleOrder.userAddress,
            },
          },
          data: expect.objectContaining({
            lockedCollateral: 0,
          }),
        })
      );
    });

    it("should reject cancelling a FILLED order", async () => {
      mockTx.order.findUnique.mockResolvedValue({
        ...sampleOrder,
        status: "FILLED",
      });

      await expect(
        matchingService.cancelOrder("order-1", sampleOrder.userAddress)
      ).rejects.toThrow(ValidationError);
      expect(mockTx.order.updateMany).not.toHaveBeenCalled();
    });

    it("should reject cancelling a non-existent order", async () => {
      mockPrismaClient.order.findUnique.mockResolvedValue(null);

      await expect(
        matchingService.cancelOrder("nonexistent", sampleOrder.userAddress)
      ).rejects.toThrow(ValidationError);
      // Rejected before ever entering the mutex/transaction.
      expect(mockPrismaClient.$transaction).not.toHaveBeenCalled();
    });

    it("should reject cancelling another user's order", async () => {
      mockTx.order.findUnique.mockResolvedValue(sampleOrder);

      await expect(
        matchingService.cancelOrder(
          "order-1",
          "GOTHER1234567890123456789012345678901234567890123456"
        )
      ).rejects.toThrow(ValidationError);
      expect(mockTx.order.updateMany).not.toHaveBeenCalled();
    });

    it("should cancel a PARTIALLY_FILLED order and release remaining collateral", async () => {
      const partiallyFilled = {
        ...sampleOrder,
        status: "PARTIALLY_FILLED",
        filledQuantity: 30,
        quantity: 100,
      };
      mockTx.order.findUnique.mockResolvedValue(partiallyFilled);
      mockTx.userPosition.findUnique.mockResolvedValue({
        marketId: "market-1",
        userAddress: sampleOrder.userAddress,
        lockedCollateral: "35",
      });

      const result = await matchingService.cancelOrder(
        "order-1",
        sampleOrder.userAddress
      );

      expect(result.status).toBe("CANCELLED");
      // Remaining qty = 70, collateral = 70 * 0.5 = 35, locked goes from 35 to 0
      expect(mockTx.userPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lockedCollateral: 0,
          }),
        })
      );
    });

    // -----------------------------------------------------------------------
    // Optimistic-concurrency conflict path (#866)
    // -----------------------------------------------------------------------

    it("throws OrderConflictError when the order version no longer matches (already filled/cancelled concurrently)", async () => {
      mockTx.order.findUnique.mockResolvedValue(sampleOrder);
      // Simulate a concurrent writer (fill or cancel) winning the race: the
      // conditional UPDATE affects zero rows.
      mockTx.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        matchingService.cancelOrder("order-1", sampleOrder.userAddress)
      ).rejects.toThrow(OrderConflictError);

      // No collateral should be released for a cancel that didn't apply.
      expect(mockTx.userPosition.update).not.toHaveBeenCalled();
    });

    it("invalidates the in-memory book on a version conflict", async () => {
      mockTx.order.findUnique.mockResolvedValue(sampleOrder);
      mockTx.order.updateMany.mockResolvedValue({ count: 0 });

      const books: Map<string, unknown> = (matchingService as any).books;
      books.set(`${sampleOrder.marketId}:${sampleOrder.outcome}`, {
        removeOrder: vi.fn(),
      });

      await expect(
        matchingService.cancelOrder("order-1", sampleOrder.userAddress)
      ).rejects.toThrow(OrderConflictError);

      expect(books.has(`${sampleOrder.marketId}:${sampleOrder.outcome}`)).toBe(
        false
      );
    });

    it("never releases negative collateral even if lockedCollateral is already below the release amount", async () => {
      mockTx.order.findUnique.mockResolvedValue(sampleOrder);
      mockTx.userPosition.findUnique.mockResolvedValue({
        marketId: "market-1",
        userAddress: sampleOrder.userAddress,
        // Less than the 50 that would normally be released for this order.
        lockedCollateral: "10",
      });

      await matchingService.cancelOrder("order-1", sampleOrder.userAddress);

      expect(mockTx.userPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lockedCollateral: 0 }),
        })
      );
    });
  });

  describe("matching engine feature flag (#744)", () => {
    const orderInput = {
      marketId: "market-1",
      userAddress: "GUSER1234567890123456789012345678901234567890123456",
      side: "BUY" as const,
      outcome: "YES" as const,
      price: 0.5,
      quantity: 10,
    };

    afterEach(() => {
      delete process.env.MATCHING_ENGINE_ENABLED;
    });

    it("isMatchingEngineEnabled() defaults to true when unset", () => {
      delete process.env.MATCHING_ENGINE_ENABLED;
      expect(isMatchingEngineEnabled()).toBe(true);
    });

    it('isMatchingEngineEnabled() is false only when explicitly set to "false"', () => {
      process.env.MATCHING_ENGINE_ENABLED = "false";
      expect(isMatchingEngineEnabled()).toBe(false);

      process.env.MATCHING_ENGINE_ENABLED = "true";
      expect(isMatchingEngineEnabled()).toBe(true);
    });

    it("placeOrder rejects with ServiceUnavailableError when the flag is disabled", async () => {
      process.env.MATCHING_ENGINE_ENABLED = "false";

      await expect(matchingService.placeOrder(orderInput)).rejects.toThrow(
        ServiceUnavailableError
      );
      // Rejected before touching the database at all.
      expect(mockPrismaClient.$transaction).not.toHaveBeenCalled();
    });

    it("placeOrder rejects with MatchingUnavailableError (503) when this instance is not the matching leader", async () => {
      process.env.MATCHING_LEASE_ENFORCED = "true";
      leaderLeaseMock.isLeader.mockReturnValue(false);

      await expect(matchingService.placeOrder(orderInput)).rejects.toThrow(
        MatchingUnavailableError
      );
      // Rejected before touching the database at all — a non-leader must
      // never queue behind (or race) the leader's in-flight work.
      expect(mockPrismaClient.$transaction).not.toHaveBeenCalled();
      process.env.MATCHING_LEASE_ENFORCED = "false";
    });

    it("placeOrder proceeds normally when the flag is enabled (default)", async () => {
      mockPrismaClient.market.findUnique.mockResolvedValue({
        id: "market-1",
        status: "ACTIVE",
        deletedAt: null,
      });
      mockPrismaClient.order.findMany.mockResolvedValue([]);
      mockTx.order.create.mockResolvedValue({
        id: "order-2",
        ...orderInput,
        status: "FILLED",
        filledQuantity: orderInput.quantity,
      });

      await expect(
        matchingService.placeOrder(orderInput)
      ).resolves.toBeDefined();
      expect(mockTx.order.create).toHaveBeenCalled();
    });
  });

  describe("placeOrder market status check (#792)", () => {
    const orderInput = {
      marketId: "market-1",
      userAddress: "GUSER1234567890123456789012345678901234567890123456",
      side: "BUY" as const,
      outcome: "YES" as const,
      price: 0.5,
      quantity: 10,
    };

    it("rejects with MarketNotActiveError when the market is CANCELLED", async () => {
      mockPrismaClient.market.findUnique.mockResolvedValue({
        id: "market-1",
        status: "CANCELLED",
        deletedAt: null,
      });

      await expect(matchingService.placeOrder(orderInput)).rejects.toThrow(
        MarketNotActiveError
      );
      // Rejected before any book/order state was touched.
      expect(mockPrismaClient.order.findMany).not.toHaveBeenCalled();
      expect(mockPrismaClient.$transaction).not.toHaveBeenCalled();
    });

    it("rejects with MarketNotActiveError when the market is RESOLVED", async () => {
      mockPrismaClient.market.findUnique.mockResolvedValue({
        id: "market-1",
        status: "RESOLVED",
        deletedAt: null,
      });

      await expect(matchingService.placeOrder(orderInput)).rejects.toThrow(
        MarketNotActiveError
      );
    });

    it("uses a stable error code regardless of the rejection reason", async () => {
      mockPrismaClient.market.findUnique.mockResolvedValue({
        id: "market-1",
        status: "CANCELLED",
        deletedAt: null,
      });

      const error = await matchingService
        .placeOrder(orderInput)
        .catch((e) => e);

      expect(error).toBeInstanceOf(MarketNotActiveError);
      expect(error.code).toBe("market_not_active");
      expect(error.statusCode).toBe(409);
    });

    it("rejects with MarketNotFoundError when the market does not exist", async () => {
      mockPrismaClient.market.findUnique.mockResolvedValue(null);

      await expect(matchingService.placeOrder(orderInput)).rejects.toThrow(
        MarketNotFoundError
      );
    });

    it("rejects with MarketNotFoundError when the market is soft-deleted", async () => {
      mockPrismaClient.market.findUnique.mockResolvedValue({
        id: "market-1",
        status: "ACTIVE",
        deletedAt: new Date(),
      });

      await expect(matchingService.placeOrder(orderInput)).rejects.toThrow(
        MarketNotFoundError
      );
    });
  });

  describe("orderbook_hydrated_markets gauge (#746)", () => {
    it("reflects the current in-memory book count after hydration", async () => {
      mockPrismaClient.market.findMany.mockResolvedValue([{ id: "market-9" }]);
      mockPrismaClient.order.findMany.mockResolvedValue([]);

      await matchingService.hydrateAllActiveMarkets();

      const snapshot = await orderbookHydratedMarketsGauge.get();
      const books: Map<string, unknown> = (matchingService as any).books;
      expect(snapshot.values[0].value).toBe(books.size);
      expect(books.size).toBe(2); // market-9 x {YES, NO}
    });
  });
});
