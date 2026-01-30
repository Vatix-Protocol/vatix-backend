/**
 * Tests for property-based test generators
 */

import * as fc from "fast-check";
import {
  orderRequestArb,
  orderArb,
  tradeArb,
  marketArb,
  invalidOrderRequestArb,
} from "./generators";

describe("Property-Based Test Generators", () => {
  describe("orderRequestArb", () => {
    it("should generate valid OrderRequest objects", () => {
      fc.assert(
        fc.property(orderRequestArb, (orderRequest) => {
          expect(typeof orderRequest.marketId).toBe("string");
          expect(["buy", "sell"]).toContain(orderRequest.side);
          expect(typeof orderRequest.outcome).toBe("string");
          expect(typeof orderRequest.quantity).toBe("number");
          expect(orderRequest.quantity).toBeGreaterThan(0);
          expect(typeof orderRequest.userAddress).toBe("string");

          if (orderRequest.price !== undefined && orderRequest.price !== null) {
            expect(orderRequest.price).toBeGreaterThan(0);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("orderArb", () => {
    it("should generate valid Order objects", () => {
      fc.assert(
        fc.property(orderArb, (order) => {
          expect(typeof order.id).toBe("string");
          expect(["buy", "sell"]).toContain(order.side);
          expect(["limit", "market"]).toContain(order.orderType);
          expect(["pending", "partial", "filled", "cancelled"]).toContain(
            order.status,
          );
          expect(order.originalQuantity).toBeGreaterThan(0);
          expect(order.remainingQuantity).toBeGreaterThanOrEqual(0);
          expect(order.createdAt).toBeInstanceOf(Date);
          expect(order.updatedAt).toBeInstanceOf(Date);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("tradeArb", () => {
    it("should generate valid Trade objects", () => {
      fc.assert(
        fc.property(tradeArb, (trade) => {
          expect(typeof trade.id).toBe("string");
          expect(typeof trade.buyOrderId).toBe("string");
          expect(typeof trade.sellOrderId).toBe("string");
          expect(trade.price).toBeGreaterThan(0);
          expect(trade.quantity).toBeGreaterThan(0);
          expect(trade.timestamp).toBeInstanceOf(Date);
          expect(typeof trade.buyerAddress).toBe("string");
          expect(typeof trade.sellerAddress).toBe("string");
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("marketArb", () => {
    it("should generate valid Market objects", () => {
      fc.assert(
        fc.property(marketArb, (market) => {
          expect(typeof market.id).toBe("string");
          expect(typeof market.title).toBe("string");
          expect(Array.isArray(market.outcomes)).toBe(true);
          expect(market.outcomes.length).toBeGreaterThanOrEqual(2);
          expect(["active", "closed", "resolved"]).toContain(market.status);
          expect(market.createdAt).toBeInstanceOf(Date);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("invalidOrderRequestArb", () => {
    it("should generate invalid OrderRequest objects", () => {
      fc.assert(
        fc.property(invalidOrderRequestArb, (invalidOrder) => {
          // At least one field should be invalid
          const hasEmptyMarketId = invalidOrder.marketId === "";
          const hasInvalidSide = !["buy", "sell"].includes(invalidOrder.side);
          const hasNegativeQuantity =
            invalidOrder.quantity <= 0 || isNaN(invalidOrder.quantity);
          const hasNegativePrice =
            "price" in invalidOrder &&
            invalidOrder.price !== undefined &&
            (invalidOrder.price <= 0 || isNaN(invalidOrder.price));

          expect(
            hasEmptyMarketId ||
              hasInvalidSide ||
              hasNegativeQuantity ||
              hasNegativePrice,
          ).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});
