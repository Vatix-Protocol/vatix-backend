import { describe, it, expect, vi } from "vitest";

// hashOrderRequest is a pure helper; stub the module-level dependencies that
// orders.ts pulls in so importing it does not open DB/Redis connections.
vi.mock("../../services/prisma.js", () => ({
  getPrismaClient: vi.fn(),
}));
vi.mock("../../services/redis.js", () => ({ redis: {} }));
vi.mock("../../services/audit.js", () => ({
  auditService: { getWalletTradeHistory: vi.fn() },
}));
vi.mock("../../matching/matching-service.js", () => ({
  matchingService: { placeOrder: vi.fn() },
}));

import { hashOrderRequest, type CreateOrderBody } from "./orders.js";

const baseOrder: CreateOrderBody = {
  marketId: "market-1",
  userAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  side: "BUY",
  outcome: "YES",
  price: 0.5,
  quantity: 10,
  limitPrice: 0.55,
  maxSlippagePct: 1,
};

describe("hashOrderRequest", () => {
  it("produces a different digest when only quantity changes", () => {
    const changed: CreateOrderBody = { ...baseOrder, quantity: 11 };

    expect(hashOrderRequest(changed)).not.toBe(hashOrderRequest(baseOrder));
  });

  it("produces the same digest regardless of object key order", () => {
    const reordered: CreateOrderBody = {
      maxSlippagePct: baseOrder.maxSlippagePct,
      limitPrice: baseOrder.limitPrice,
      quantity: baseOrder.quantity,
      price: baseOrder.price,
      outcome: baseOrder.outcome,
      side: baseOrder.side,
      userAddress: baseOrder.userAddress,
      marketId: baseOrder.marketId,
    };

    expect(hashOrderRequest(reordered)).toBe(hashOrderRequest(baseOrder));
  });
});
