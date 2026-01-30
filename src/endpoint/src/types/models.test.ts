/**
 * Tests for data models and type definitions
 */

import { Order, Trade, Position, Market, OrderBook } from "./models";

describe("Data Models", () => {
  describe("Order interface", () => {
    it("should have all required properties", () => {
      const order: Order = {
        id: "test-id",
        marketId: "market-1",
        userAddress: "0x123",
        side: "buy",
        outcome: "yes",
        orderType: "limit",
        price: 0.5,
        originalQuantity: 100,
        remainingQuantity: 50,
        status: "partial",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(order.id).toBe("test-id");
      expect(order.side).toBe("buy");
      expect(order.orderType).toBe("limit");
      expect(order.status).toBe("partial");
    });

    it("should allow market orders without price", () => {
      const marketOrder: Order = {
        id: "test-id",
        marketId: "market-1",
        userAddress: "0x123",
        side: "sell",
        outcome: "no",
        orderType: "market",
        originalQuantity: 100,
        remainingQuantity: 0,
        status: "filled",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(marketOrder.price).toBeUndefined();
      expect(marketOrder.orderType).toBe("market");
    });
  });

  describe("Trade interface", () => {
    it("should have all required properties", () => {
      const trade: Trade = {
        id: "trade-1",
        buyOrderId: "buy-order-1",
        sellOrderId: "sell-order-1",
        price: 0.6,
        quantity: 50,
        timestamp: new Date(),
        buyerAddress: "0x123",
        sellerAddress: "0x456",
      };

      expect(trade.buyOrderId).toBe("buy-order-1");
      expect(trade.sellOrderId).toBe("sell-order-1");
      expect(trade.price).toBe(0.6);
      expect(trade.quantity).toBe(50);
    });
  });

  describe("Market interface", () => {
    it("should have all required properties", () => {
      const market: Market = {
        id: "market-1",
        title: "Test Market",
        outcomes: ["yes", "no"],
        status: "active",
        createdAt: new Date(),
      };

      expect(market.outcomes).toHaveLength(2);
      expect(market.status).toBe("active");
      expect(market.resolvedAt).toBeUndefined();
    });
  });

  describe("OrderBook interface", () => {
    it("should contain buy and sell orders", () => {
      const orderBook: OrderBook = {
        marketId: "market-1",
        buyOrders: [],
        sellOrders: [],
      };

      expect(orderBook.buyOrders).toEqual([]);
      expect(orderBook.sellOrders).toEqual([]);
    });
  });
});
