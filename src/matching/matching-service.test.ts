import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ValidationError,
  ServiceUnavailableError,
} from "../api/middleware/errors.js";

// Mock dependencies
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
    create: vi.fn(),
  },
  trade: {
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
  $transaction: vi.fn((cb: (tx: any) => Promise<any>) => cb(mockTx)),
};

import {
  matchingService,
  isMatchingEngineEnabled,
} from "./matching-service.js";
import { orderbookHydratedMarketsGauge } from "../services/metrics.js";

describe("MatchingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (matchingService as any).books?.clear();
    (matchingService as any).mutexes?.clear();
    mockPrismaClient.$transaction.mockImplementation(
      (cb: (tx: any) => Promise<any>) => cb(mockTx)
    );
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
      createdAt: now,
    };

    it("should cancel an OPEN order and release collateral", async () => {
      mockTx.order.findUnique.mockResolvedValue(sampleOrder);
      mockTx.userPosition.findUnique.mockResolvedValue({
        marketId: "market-1",
        userAddress: sampleOrder.userAddress,
        lockedCollateral: "50",
      });
      mockTx.order.update.mockResolvedValue({
        ...sampleOrder,
        status: "CANCELLED",
      });

      const result = await matchingService.cancelOrder(
        "order-1",
        sampleOrder.userAddress
      );

      expect(result.status).toBe("CANCELLED");
      expect(mockTx.order.findUnique).toHaveBeenCalledWith({
        where: { id: "order-1" },
      });
      expect(mockTx.order.update).toHaveBeenCalledWith({
        where: { id: "order-1" },
        data: { status: "CANCELLED" },
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
    });

    it("should reject cancelling a non-existent order", async () => {
      mockTx.order.findUnique.mockResolvedValue(null);

      await expect(
        matchingService.cancelOrder("nonexistent", sampleOrder.userAddress)
      ).rejects.toThrow(ValidationError);
    });

    it("should reject cancelling another user's order", async () => {
      mockTx.order.findUnique.mockResolvedValue(sampleOrder);

      await expect(
        matchingService.cancelOrder(
          "order-1",
          "GOTHER1234567890123456789012345678901234567890123456"
        )
      ).rejects.toThrow(ValidationError);
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
      mockTx.order.update.mockResolvedValue({
        ...partiallyFilled,
        status: "CANCELLED",
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

    it("placeOrder proceeds normally when the flag is enabled (default)", async () => {
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
