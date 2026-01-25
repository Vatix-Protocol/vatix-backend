import { describe, it, expect, beforeEach } from "vitest";
import { OrderBook, Order } from "./orderbook";

describe("OrderBook", () => {
  let orderBook: OrderBook;
  const marketId = "market-1";
  const outcome = 0;

  beforeEach(() => {
    orderBook = new OrderBook(marketId, outcome);
  });

  const createOrder = (
    id: string,
    side: "bid" | "ask",
    price: number,
    quantity: number,
    timestamp: number = Date.now(),
    userAddress: string = "user1",
  ): Order => ({
    id,
    userAddress,
    side,
    price,
    quantity,
    timestamp,
    marketId,
    outcome,
  });

  describe("Order Insertion", () => {
    it("should add orders and maintain correct sort order for bids (high to low)", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100, 1000));
      orderBook.addOrder(createOrder("2", "bid", 55, 100, 2000));
      orderBook.addOrder(createOrder("3", "bid", 45, 100, 3000));

      const bestBid = orderBook.getBestBid();
      expect(bestBid?.price).toBe(55);
      expect(bestBid?.id).toBe("2");

      const depth = orderBook.getDepth(3);
      expect(depth.bids[0].price).toBe(55);
      expect(depth.bids[1].price).toBe(50);
      expect(depth.bids[2].price).toBe(45);
    });

    it("should add orders and maintain correct sort order for asks (low to high)", () => {
      orderBook.addOrder(createOrder("1", "ask", 60, 100, 1000));
      orderBook.addOrder(createOrder("2", "ask", 55, 100, 2000));
      orderBook.addOrder(createOrder("3", "ask", 65, 100, 3000));

      const bestAsk = orderBook.getBestAsk();
      expect(bestAsk?.price).toBe(55);
      expect(bestAsk?.id).toBe("2");

      const depth = orderBook.getDepth(3);
      expect(depth.asks[0].price).toBe(55);
      expect(depth.asks[1].price).toBe(60);
      expect(depth.asks[2].price).toBe(65);
    });

    it("should enforce time priority for orders at same price", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100, 1000));
      orderBook.addOrder(createOrder("2", "bid", 50, 100, 2000));
      orderBook.addOrder(createOrder("3", "bid", 50, 100, 3000));

      const bestBid = orderBook.getBestBid();
      expect(bestBid?.id).toBe("1"); // First order at this price

      const ordersAt50 = orderBook.getOrdersAtPrice("bid", 50);
      expect(ordersAt50[0].id).toBe("1");
      expect(ordersAt50[1].id).toBe("2");
      expect(ordersAt50[2].id).toBe("3");
    });

    it("should throw error for duplicate order ID", () => {
      const order = createOrder("1", "bid", 50, 100);
      orderBook.addOrder(order);

      expect(() => {
        orderBook.addOrder(order);
      }).toThrow("Order 1 already exists");
    });

    it("should throw error for mismatched market or outcome", () => {
      const order = createOrder("1", "bid", 50, 100);
      order.marketId = "different-market";

      expect(() => {
        orderBook.addOrder(order);
      }).toThrow("Order does not match this order book");
    });
  });

  describe("Best Bid/Ask Retrieval", () => {
    it("should return null for best bid when book is empty", () => {
      expect(orderBook.getBestBid()).toBeNull();
    });

    it("should return null for best ask when book is empty", () => {
      expect(orderBook.getBestAsk()).toBeNull();
    });

    it("should return best bid in O(1) time", () => {
      // Add multiple orders
      for (let i = 0; i < 100; i++) {
        orderBook.addOrder(createOrder(`bid-${i}`, "bid", 40 + i, 100));
      }

      const start = performance.now();
      const bestBid = orderBook.getBestBid();
      const duration = performance.now() - start;

      expect(bestBid?.price).toBe(139); // Highest price
      expect(duration).toBeLessThan(1); // Should be near-instant
    });

    it("should return best ask in O(1) time", () => {
      // Add multiple orders
      for (let i = 0; i < 100; i++) {
        orderBook.addOrder(createOrder(`ask-${i}`, "ask", 60 + i, 100));
      }

      const start = performance.now();
      const bestAsk = orderBook.getBestAsk();
      const duration = performance.now() - start;

      expect(bestAsk?.price).toBe(60); // Lowest price
      expect(duration).toBeLessThan(1); // Should be near-instant
    });
  });

  describe("Order Removal", () => {
    it("should remove order from middle of price level", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100, 1000));
      orderBook.addOrder(createOrder("2", "bid", 50, 100, 2000));
      orderBook.addOrder(createOrder("3", "bid", 50, 100, 3000));

      const removed = orderBook.removeOrder("2");
      expect(removed?.id).toBe("2");

      const ordersAt50 = orderBook.getOrdersAtPrice("bid", 50);
      expect(ordersAt50.length).toBe(2);
      expect(ordersAt50[0].id).toBe("1");
      expect(ordersAt50[1].id).toBe("3");
    });

    it("should remove price level when last order is removed", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100));
      orderBook.removeOrder("1");

      const depth = orderBook.getDepth(10);
      expect(depth.bids.length).toBe(0);
    });

    it("should update best bid after removal", () => {
      orderBook.addOrder(createOrder("1", "bid", 55, 100));
      orderBook.addOrder(createOrder("2", "bid", 50, 100));

      orderBook.removeOrder("1");

      const bestBid = orderBook.getBestBid();
      expect(bestBid?.price).toBe(50);
      expect(bestBid?.id).toBe("2");
    });

    it("should return null when removing non-existent order", () => {
      const removed = orderBook.removeOrder("non-existent");
      expect(removed).toBeNull();
    });

    it("should remove order from user index", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100, 1000, "user1"));
      orderBook.addOrder(createOrder("2", "bid", 55, 100, 2000, "user1"));

      orderBook.removeOrder("1");

      const userOrders = orderBook.getOrdersByUser("user1");
      expect(userOrders.length).toBe(1);
      expect(userOrders[0].id).toBe("2");
    });
  });

  describe("Depth Calculation", () => {
    it("should aggregate quantities at each price level", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100));
      orderBook.addOrder(createOrder("2", "bid", 50, 150));
      orderBook.addOrder(createOrder("3", "bid", 50, 200));
      orderBook.addOrder(createOrder("4", "bid", 45, 300));

      const depth = orderBook.getDepth(10);

      expect(depth.bids[0].price).toBe(50);
      expect(depth.bids[0].quantity).toBe(450); // 100 + 150 + 200
      expect(depth.bids[0].orderCount).toBe(3);

      expect(depth.bids[1].price).toBe(45);
      expect(depth.bids[1].quantity).toBe(300);
      expect(depth.bids[1].orderCount).toBe(1);
    });

    it("should limit depth to requested levels", () => {
      for (let i = 0; i < 10; i++) {
        orderBook.addOrder(createOrder(`bid-${i}`, "bid", 50 - i, 100));
        orderBook.addOrder(createOrder(`ask-${i}`, "ask", 60 + i, 100));
      }

      const depth = orderBook.getDepth(5);
      expect(depth.bids.length).toBe(5);
      expect(depth.asks.length).toBe(5);
    });

    it("should return correct depth for both sides", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100));
      orderBook.addOrder(createOrder("2", "bid", 49, 200));
      orderBook.addOrder(createOrder("3", "ask", 51, 150));
      orderBook.addOrder(createOrder("4", "ask", 52, 250));

      const depth = orderBook.getDepth(10);

      expect(depth.bids.length).toBe(2);
      expect(depth.bids[0].price).toBe(50);
      expect(depth.bids[1].price).toBe(49);

      expect(depth.asks.length).toBe(2);
      expect(depth.asks[0].price).toBe(51);
      expect(depth.asks[1].price).toBe(52);
    });
  });

  describe("Partial Fills", () => {
    it("should update order quantity correctly", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100));

      const updated = orderBook.updateOrderQuantity("1", 60);
      expect(updated).toBe(true);

      const depth = orderBook.getDepth(1);
      expect(depth.bids[0].quantity).toBe(60);
    });

    it("should remove order when quantity becomes zero", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100));

      orderBook.updateOrderQuantity("1", 0);

      const depth = orderBook.getDepth(1);
      expect(depth.bids.length).toBe(0);
    });

    it("should update total quantity at price level", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100));
      orderBook.addOrder(createOrder("2", "bid", 50, 100));

      orderBook.updateOrderQuantity("1", 50);

      const depth = orderBook.getDepth(1);
      expect(depth.bids[0].quantity).toBe(150); // 50 + 100
    });

    it("should throw error for negative quantity", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100));

      expect(() => {
        orderBook.updateOrderQuantity("1", -10);
      }).toThrow("Quantity cannot be negative");
    });

    it("should return false for non-existent order", () => {
      const updated = orderBook.updateOrderQuantity("non-existent", 50);
      expect(updated).toBe(false);
    });
  });

  describe("User Orders", () => {
    it("should return all orders for a user", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100, 1000, "user1"));
      orderBook.addOrder(createOrder("2", "ask", 60, 100, 2000, "user1"));
      orderBook.addOrder(createOrder("3", "bid", 55, 100, 3000, "user2"));

      const user1Orders = orderBook.getOrdersByUser("user1");
      expect(user1Orders.length).toBe(2);
      expect(user1Orders.map((o) => o.id).sort()).toEqual(["1", "2"]);

      const user2Orders = orderBook.getOrdersByUser("user2");
      expect(user2Orders.length).toBe(1);
      expect(user2Orders[0].id).toBe("3");
    });

    it("should return empty array for user with no orders", () => {
      const orders = orderBook.getOrdersByUser("non-existent-user");
      expect(orders).toEqual([]);
    });
  });

  describe("Performance", () => {
    it("should handle 1000+ orders efficiently", () => {
      const start = performance.now();

      // Insert 1000 orders
      for (let i = 0; i < 1000; i++) {
        orderBook.addOrder(
          createOrder(
            `order-${i}`,
            i % 2 === 0 ? "bid" : "ask",
            50 + (i % 100),
            100,
            Date.now() + i,
          ),
        );
      }

      const insertDuration = performance.now() - start;

      // Should complete in reasonable time (< 100ms)
      expect(insertDuration).toBeLessThan(100);
      expect(orderBook.getOrderCount()).toBe(1000);

      // Best bid/ask should still be O(1)
      const bestStart = performance.now();
      orderBook.getBestBid();
      orderBook.getBestAsk();
      const bestDuration = performance.now() - bestStart;
      expect(bestDuration).toBeLessThan(1);

      // Depth calculation should be fast
      const depthStart = performance.now();
      orderBook.getDepth(10);
      const depthDuration = performance.now() - depthStart;
      expect(depthDuration).toBeLessThan(5);
    });

    it("should maintain performance with many price levels", () => {
      // Create 100 different price levels
      for (let i = 0; i < 100; i++) {
        orderBook.addOrder(createOrder(`bid-${i}`, "bid", 1 + i, 100));
        orderBook.addOrder(createOrder(`ask-${i}`, "ask", 200 + i, 100));
      }

      const start = performance.now();
      orderBook.getBestBid();
      orderBook.getBestAsk();
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(1);
    });
  });

  describe("Additional Features", () => {
    it("should calculate total volume correctly", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100));
      orderBook.addOrder(createOrder("2", "bid", 49, 200));
      orderBook.addOrder(createOrder("3", "ask", 51, 150));
      orderBook.addOrder(createOrder("4", "ask", 52, 250));

      const volume = orderBook.getTotalVolume();
      expect(volume.bidVolume).toBe(300);
      expect(volume.askVolume).toBe(400);
    });

    it("should calculate spread correctly", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100));
      orderBook.addOrder(createOrder("2", "ask", 52, 100));

      const spread = orderBook.getSpread();
      expect(spread).toBe(2);
    });

    it("should return null spread when one side is empty", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100));

      const spread = orderBook.getSpread();
      expect(spread).toBeNull();
    });

    it("should clear all orders", () => {
      orderBook.addOrder(createOrder("1", "bid", 50, 100));
      orderBook.addOrder(createOrder("2", "ask", 60, 100));

      orderBook.clear();

      expect(orderBook.getOrderCount()).toBe(0);
      expect(orderBook.getBestBid()).toBeNull();
      expect(orderBook.getBestAsk()).toBeNull();
    });

    it("should iterate orders in price-time priority", () => {
      orderBook.addOrder(createOrder("1", "bid", 55, 100, 1000));
      orderBook.addOrder(createOrder("2", "bid", 50, 100, 2000));
      orderBook.addOrder(createOrder("3", "bid", 55, 100, 3000));
      orderBook.addOrder(createOrder("4", "bid", 60, 100, 4000));

      const orderIds: string[] = [];
      for (const order of orderBook.iterateOrders("bid")) {
        orderIds.push(order.id);
      }

      // Should be sorted: price desc, then time asc
      expect(orderIds).toEqual(["4", "1", "3", "2"]);
    });
  });
});
