// Order representation in the order book
export interface Order {
  id: string;
  userAddress: string;
  side: "bid" | "ask";
  price: number;
  quantity: number;
  timestamp: number;
  marketId: string;
  outcome: number;
}

// Price level in the order book containing all orders at that price
interface PriceLevel {
  price: number;
  orders: Order[];
  totalQuantity: number;
}

// Depth information for a price level
export interface DepthLevel {
  price: number;
  quantity: number;
  orderCount: number;
}

// High-performance order book implementation using sorted price levels
// Maintains bid/ask orders sorted by price-time priority
export class OrderBook {
  private marketId: string;
  private outcome: number;

  private bidLevels: Map<number, PriceLevel> = new Map();
  private askLevels: Map<number, PriceLevel> = new Map();

  private bidPrices: number[] = []; // Sorted high to low
  private askPrices: number[] = []; // Sorted low to high

  private orderMap: Map<string, Order> = new Map();

  private userOrders: Map<string, Set<string>> = new Map();

  constructor(marketId: string, outcome: number) {
    this.marketId = marketId;
    this.outcome = outcome;
  }

  // Add an order to the book - O(log n) complexity
  addOrder(order: Order): void {
    if (order.marketId !== this.marketId || order.outcome !== this.outcome) {
      throw new Error("Order does not match this order book");
    }

    if (this.orderMap.has(order.id)) {
      throw new Error(`Order ${order.id} already exists`);
    }

    const levels = order.side === "bid" ? this.bidLevels : this.askLevels;
    const prices = order.side === "bid" ? this.bidPrices : this.askPrices;

    let level = levels.get(order.price);
    if (!level) {
      level = {
        price: order.price,
        orders: [],
        totalQuantity: 0,
      };
      levels.set(order.price, level);

      this.insertPrice(prices, order.price, order.side === "bid");
    }

    level.orders.push(order);
    level.totalQuantity += order.quantity;

    this.orderMap.set(order.id, order);

    if (!this.userOrders.has(order.userAddress)) {
      this.userOrders.set(order.userAddress, new Set());
    }
    this.userOrders.get(order.userAddress)!.add(order.id);
  }

  // Remove an order from the book
  removeOrder(orderId: string): Order | null {
    const order = this.orderMap.get(orderId);
    if (!order) {
      return null;
    }

    const levels = order.side === "bid" ? this.bidLevels : this.askLevels;
    const prices = order.side === "bid" ? this.bidPrices : this.askPrices;

    const level = levels.get(order.price);
    if (!level) {
      return null;
    }

    const orderIndex = level.orders.findIndex((o) => o.id === orderId);
    if (orderIndex !== -1) {
      level.orders.splice(orderIndex, 1);
      level.totalQuantity -= order.quantity;
    }

    if (level.orders.length === 0) {
      levels.delete(order.price);
      const priceIndex = prices.indexOf(order.price);
      if (priceIndex !== -1) {
        prices.splice(priceIndex, 1);
      }
    }

    this.orderMap.delete(orderId);
    const userOrderSet = this.userOrders.get(order.userAddress);
    if (userOrderSet) {
      userOrderSet.delete(orderId);
      if (userOrderSet.size === 0) {
        this.userOrders.delete(order.userAddress);
      }
    }

    return order;
  }

  // Get the best bid (highest price) - O(1)
  getBestBid(): Order | null {
    if (this.bidPrices.length === 0) {
      return null;
    }

    const bestPrice = this.bidPrices[0];
    const level = this.bidLevels.get(bestPrice);
    return level && level.orders.length > 0 ? level.orders[0] : null;
  }

  // Get the best ask (lowest price) - O(1)
  getBestAsk(): Order | null {
    if (this.askPrices.length === 0) {
      return null;
    }

    const bestPrice = this.askPrices[0];
    const level = this.askLevels.get(bestPrice);
    return level && level.orders.length > 0 ? level.orders[0] : null;
  }

  // Get all orders for a specific user
  getOrdersByUser(userAddress: string): Order[] {
    const orderIds = this.userOrders.get(userAddress);
    if (!orderIds) {
      return [];
    }

    const orders: Order[] = [];
    for (const orderId of orderIds) {
      const order = this.orderMap.get(orderId);
      if (order) {
        orders.push(order);
      }
    }
    return orders;
  }

  // Get aggregated depth by price level
  getDepth(levels: number): { bids: DepthLevel[]; asks: DepthLevel[] } {
    const bids: DepthLevel[] = [];
    const asks: DepthLevel[] = [];

    for (let i = 0; i < Math.min(levels, this.bidPrices.length); i++) {
      const price = this.bidPrices[i];
      const level = this.bidLevels.get(price);
      if (level) {
        bids.push({
          price: level.price,
          quantity: level.totalQuantity,
          orderCount: level.orders.length,
        });
      }
    }

    for (let i = 0; i < Math.min(levels, this.askPrices.length); i++) {
      const price = this.askPrices[i];
      const level = this.askLevels.get(price);
      if (level) {
        asks.push({
          price: level.price,
          quantity: level.totalQuantity,
          orderCount: level.orders.length,
        });
      }
    }

    return { bids, asks };
  }

  // Update order quantity after partial fill
  updateOrderQuantity(orderId: string, newQuantity: number): boolean {
    const order = this.orderMap.get(orderId);
    if (!order) {
      return false;
    }

    if (newQuantity < 0) {
      throw new Error("Quantity cannot be negative");
    }

    if (newQuantity === 0) {
      this.removeOrder(orderId);
      return true;
    }

    const levels = order.side === "bid" ? this.bidLevels : this.askLevels;
    const level = levels.get(order.price);
    if (!level) {
      return false;
    }

    const quantityDelta = newQuantity - order.quantity;
    level.totalQuantity += quantityDelta;

    order.quantity = newQuantity;

    return true;
  }

  // Get all orders at a specific price level
  getOrdersAtPrice(side: "bid" | "ask", price: number): Order[] {
    const levels = side === "bid" ? this.bidLevels : this.askLevels;
    const level = levels.get(price);
    return level ? [...level.orders] : [];
  }

  // Get total volume in the order book
  getTotalVolume(): { bidVolume: number; askVolume: number } {
    let bidVolume = 0;
    let askVolume = 0;

    for (const level of this.bidLevels.values()) {
      bidVolume += level.totalQuantity;
    }

    for (const level of this.askLevels.values()) {
      askVolume += level.totalQuantity;
    }

    return { bidVolume, askVolume };
  }

  // Get the spread (difference between best bid and best ask)
  getSpread(): number | null {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();

    if (!bestBid || !bestAsk) {
      return null;
    }

    return bestAsk.price - bestBid.price;
  }

  // Clear all orders from the book
  clear(): void {
    this.bidLevels.clear();
    this.askLevels.clear();
    this.bidPrices = [];
    this.askPrices = [];
    this.orderMap.clear();
    this.userOrders.clear();
  }

  // Get order count
  getOrderCount(): number {
    return this.orderMap.size;
  }

  // Insert price into sorted array maintaining order
  // Bids: high to low, Asks: low to high
  private insertPrice(
    prices: number[],
    price: number,
    descending: boolean,
  ): void {
    let left = 0;
    let right = prices.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      const comparison = descending ? prices[mid] > price : prices[mid] < price;

      if (comparison) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    prices.splice(left, 0, price);
  }

  // Iterate through orders for matching (price-time priority)
  *iterateOrders(side: "bid" | "ask"): Generator<Order> {
    const prices = side === "bid" ? this.bidPrices : this.askPrices;
    const levels = side === "bid" ? this.bidLevels : this.askLevels;

    for (const price of prices) {
      const level = levels.get(price);
      if (level) {
        for (const order of level.orders) {
          yield order;
        }
      }
    }
  }
}
