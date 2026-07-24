import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationError } from "../api/middleware/errors.js";

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

vi.mock("./mutex.js", () => {
  return {
    Mutex: vi.fn().mockImplementation(() => ({
      run: vi.fn((fn: () => Promise<any>) => fn()),
    })),
  };
});

vi.mock("./engine.js", () => {
  const actual = vi.importActual("./engine.js");
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
  },
  userPosition: {
    findUnique: vi.fn(),
    update: vi.fn(),
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

import { matchingService } from "./matching-service.js";

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
});
