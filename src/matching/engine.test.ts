import { describe, it, expect, beforeEach } from 'vitest';
import { matchOrder, MatchingOrder, Trade, MatchResult, PositionDelta, outcomeToNumber } from './engine';
import { OrderBook, Order as BookOrder } from './orderbook';

describe('matchOrder', () => {
  let orderBook: OrderBook;
  const marketId = 'market-1';
  const outcome = 0; // YES

  beforeEach(() => {
    orderBook = new OrderBook(marketId, outcome);
  });

  // Helper to create a book order (internal format)
  const createBookOrder = (
    id: string,
    side: 'bid' | 'ask',
    price: number,
    quantity: number,
    timestamp: number = Date.now(),
    userAddress: string = 'GMAKER1234567890123456789012345678901234567890123456'
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

  // Helper to create a matching order (external format)
  const createMatchingOrder = (
    id: string,
    side: 'BUY' | 'SELL',
    price: number,
    quantity: number,
    userAddress: string = 'GTAKER1234567890123456789012345678901234567890123456'
  ): MatchingOrder => ({
    id,
    userAddress,
    side,
    price,
    quantity,
    marketId,
    outcome: 'YES',
    timestamp: Date.now(),
  });

  describe('Basic Matching', () => {
    it('should match buy order with sell order at same price', () => {
      // Add a sell order (ask) to the book
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.50, 100, 1000));

      // Create a buy order at the same price
      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].price).toBe(0.50);
      expect(result.trades[0].quantity).toBe(100);
      expect(result.trades[0].buyOrderId).toBe('buy-1');
      expect(result.trades[0].sellOrderId).toBe('sell-1');
      expect(result.remainingOrder).toBeNull();
    });

    it('should match sell order with buy order at same price', () => {
      // Add a buy order (bid) to the book
      orderBook.addOrder(createBookOrder('buy-1', 'bid', 0.50, 100, 1000));

      // Create a sell order at the same price
      const sellOrder = createMatchingOrder('sell-1', 'SELL', 0.50, 100);

      const result = matchOrder(sellOrder, orderBook);

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].price).toBe(0.50);
      expect(result.trades[0].quantity).toBe(100);
      expect(result.trades[0].buyOrderId).toBe('buy-1');
      expect(result.trades[0].sellOrderId).toBe('sell-1');
      expect(result.remainingOrder).toBeNull();
    });

    it('should match buy order when ask price is lower than bid', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.40, 100, 1000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].price).toBe(0.40); // Maker's price
      expect(result.trades[0].quantity).toBe(100);
      expect(result.remainingOrder).toBeNull();
    });

    it('should match sell order when bid price is higher than ask', () => {
      orderBook.addOrder(createBookOrder('buy-1', 'bid', 0.60, 100, 1000));

      const sellOrder = createMatchingOrder('sell-1', 'SELL', 0.50, 100);

      const result = matchOrder(sellOrder, orderBook);

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].price).toBe(0.60); // Maker's price
      expect(result.trades[0].quantity).toBe(100);
      expect(result.remainingOrder).toBeNull();
    });
  });

  describe('Partial Fills', () => {
    it('should partially fill large buy order against smaller sell', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.50, 50, 1000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].quantity).toBe(50);
      expect(result.remainingOrder).not.toBeNull();
      expect(result.remainingOrder?.quantity).toBe(50);
    });

    it('should fill buy order against multiple sell orders', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.45, 30, 1000));
      orderBook.addOrder(createBookOrder('sell-2', 'ask', 0.48, 40, 2000));
      orderBook.addOrder(createBookOrder('sell-3', 'ask', 0.50, 50, 3000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades.length).toBe(3);
      expect(result.trades[0].sellOrderId).toBe('sell-1');
      expect(result.trades[0].price).toBe(0.45);
      expect(result.trades[0].quantity).toBe(30);

      expect(result.trades[1].sellOrderId).toBe('sell-2');
      expect(result.trades[1].price).toBe(0.48);
      expect(result.trades[1].quantity).toBe(40);

      expect(result.trades[2].sellOrderId).toBe('sell-3');
      expect(result.trades[2].price).toBe(0.50);
      expect(result.trades[2].quantity).toBe(30);

      expect(result.remainingOrder).toBeNull();
    });

    it('should fill sell order against multiple buy orders', () => {
      orderBook.addOrder(createBookOrder('buy-1', 'bid', 0.55, 30, 1000));
      orderBook.addOrder(createBookOrder('buy-2', 'bid', 0.52, 40, 2000));
      orderBook.addOrder(createBookOrder('buy-3', 'bid', 0.50, 50, 3000));

      const sellOrder = createMatchingOrder('sell-1', 'SELL', 0.50, 100);

      const result = matchOrder(sellOrder, orderBook);

      expect(result.trades.length).toBe(3);
      expect(result.trades[0].buyOrderId).toBe('buy-1');
      expect(result.trades[0].price).toBe(0.55);
      expect(result.trades[0].quantity).toBe(30);

      expect(result.trades[1].buyOrderId).toBe('buy-2');
      expect(result.trades[1].price).toBe(0.52);
      expect(result.trades[1].quantity).toBe(40);

      expect(result.trades[2].buyOrderId).toBe('buy-3');
      expect(result.trades[2].price).toBe(0.50);
      expect(result.trades[2].quantity).toBe(30);

      expect(result.remainingOrder).toBeNull();
    });
  });

  describe('Price-Time Priority', () => {
    it('should match with best price first (lowest ask for buy)', () => {
      orderBook.addOrder(createBookOrder('sell-high', 'ask', 0.60, 50, 1000));
      orderBook.addOrder(createBookOrder('sell-low', 'ask', 0.40, 50, 2000));
      orderBook.addOrder(createBookOrder('sell-mid', 'ask', 0.50, 50, 3000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.60, 50);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].sellOrderId).toBe('sell-low');
      expect(result.trades[0].price).toBe(0.40);
    });

    it('should match with best price first (highest bid for sell)', () => {
      orderBook.addOrder(createBookOrder('buy-low', 'bid', 0.40, 50, 1000));
      orderBook.addOrder(createBookOrder('buy-high', 'bid', 0.60, 50, 2000));
      orderBook.addOrder(createBookOrder('buy-mid', 'bid', 0.50, 50, 3000));

      const sellOrder = createMatchingOrder('sell-1', 'SELL', 0.40, 50);

      const result = matchOrder(sellOrder, orderBook);

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].buyOrderId).toBe('buy-high');
      expect(result.trades[0].price).toBe(0.60);
    });

    it('should respect time priority at same price level', () => {
      // Add multiple orders at the same price
      orderBook.addOrder(createBookOrder('sell-first', 'ask', 0.50, 30, 1000));
      orderBook.addOrder(createBookOrder('sell-second', 'ask', 0.50, 30, 2000));
      orderBook.addOrder(createBookOrder('sell-third', 'ask', 0.50, 30, 3000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 60);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades.length).toBe(2);
      expect(result.trades[0].sellOrderId).toBe('sell-first');
      expect(result.trades[1].sellOrderId).toBe('sell-second');
    });
  });

  describe('No Match Scenarios', () => {
    it('should return no trades when no matching orders exist', () => {
      // Only asks exist, but buy price is too low
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.60, 100, 1000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.40, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades.length).toBe(0);
      expect(result.remainingOrder).not.toBeNull();
      expect(result.remainingOrder?.quantity).toBe(100);
    });

    it('should return no trades when prices do not overlap', () => {
      // Bid price lower than ask price
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.70, 100, 1000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades.length).toBe(0);
      expect(result.remainingOrder?.quantity).toBe(100);
    });

    it('should return full order as remaining when book is empty', () => {
      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades.length).toBe(0);
      expect(result.remainingOrder).not.toBeNull();
      expect(result.remainingOrder?.quantity).toBe(100);
      expect(result.remainingOrder?.id).toBe('buy-1');
    });

    it('should not match buy against other bids', () => {
      // Only bids in book, buy order should not match
      orderBook.addOrder(createBookOrder('bid-1', 'bid', 0.50, 100, 1000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades.length).toBe(0);
      expect(result.remainingOrder?.quantity).toBe(100);
    });

    it('should not match sell against other asks', () => {
      // Only asks in book, sell order should not match
      orderBook.addOrder(createBookOrder('ask-1', 'ask', 0.50, 100, 1000));

      const sellOrder = createMatchingOrder('sell-1', 'SELL', 0.50, 100);

      const result = matchOrder(sellOrder, orderBook);

      expect(result.trades.length).toBe(0);
      expect(result.remainingOrder?.quantity).toBe(100);
    });
  });

  describe('Edge Cases', () => {
    it('should handle exact quantity match', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.50, 100, 1000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].quantity).toBe(100);
      expect(result.remainingOrder).toBeNull();
    });

    it('should return null remainingOrder when fully filled', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.50, 200, 1000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.remainingOrder).toBeNull();
    });

    it('should handle multiple matches in one call', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.45, 10, 1000));
      orderBook.addOrder(createBookOrder('sell-2', 'ask', 0.46, 20, 2000));
      orderBook.addOrder(createBookOrder('sell-3', 'ask', 0.47, 30, 3000));
      orderBook.addOrder(createBookOrder('sell-4', 'ask', 0.48, 40, 4000));
      orderBook.addOrder(createBookOrder('sell-5', 'ask', 0.49, 50, 5000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.49, 150);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades.length).toBe(5);
      expect(result.remainingOrder).toBeNull();
    });

    it('should stop matching when price limit reached', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.40, 50, 1000));
      orderBook.addOrder(createBookOrder('sell-2', 'ask', 0.45, 50, 2000));
      orderBook.addOrder(createBookOrder('sell-3', 'ask', 0.60, 50, 3000)); // Too expensive

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 150);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades.length).toBe(2);
      expect(result.remainingOrder?.quantity).toBe(50);
    });
  });

  describe('Order Book Integrity', () => {
    it('should remove fully filled orders from book', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.50, 100, 1000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);
      matchOrder(buyOrder, orderBook);

      expect(orderBook.getBestAsk()).toBeNull();
      expect(orderBook.getOrderCount()).toBe(0);
    });

    it('should update partially filled order quantity', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.50, 100, 1000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 60);
      matchOrder(buyOrder, orderBook);

      const bestAsk = orderBook.getBestAsk();
      expect(bestAsk).not.toBeNull();
      expect(bestAsk?.quantity).toBe(40);
      expect(bestAsk?.id).toBe('sell-1');
    });

    it('should not modify book when no matches occur', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.70, 100, 1000));

      const initialCount = orderBook.getOrderCount();
      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);
      matchOrder(buyOrder, orderBook);

      expect(orderBook.getOrderCount()).toBe(initialCount);
      expect(orderBook.getBestAsk()?.quantity).toBe(100);
    });

    it('should maintain order book consistency after multiple matches', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.50, 100, 1000));
      orderBook.addOrder(createBookOrder('sell-2', 'ask', 0.55, 100, 2000));
      orderBook.addOrder(createBookOrder('sell-3', 'ask', 0.60, 100, 3000));

      // First match: consumes sell-1 fully
      matchOrder(createMatchingOrder('buy-1', 'BUY', 0.50, 100), orderBook);
      expect(orderBook.getBestAsk()?.id).toBe('sell-2');

      // Second match: consumes sell-2 partially
      matchOrder(createMatchingOrder('buy-2', 'BUY', 0.55, 50), orderBook);
      expect(orderBook.getBestAsk()?.id).toBe('sell-2');
      expect(orderBook.getBestAsk()?.quantity).toBe(50);

      // Third match: consumes remaining sell-2
      matchOrder(createMatchingOrder('buy-3', 'BUY', 0.55, 50), orderBook);
      expect(orderBook.getBestAsk()?.id).toBe('sell-3');
    });
  });

  describe('Trade Record Correctness', () => {
    it('should set correct buyer/seller based on order side (buy order)', () => {
      const sellerAddress = 'GSELLER234567890123456789012345678901234567890123456';
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.50, 100, 1000, sellerAddress));

      const buyerAddress = 'GBUYER1234567890123456789012345678901234567890123456';
      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100, buyerAddress);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades[0].buyerAddress).toBe(buyerAddress);
      expect(result.trades[0].sellerAddress).toBe(sellerAddress);
      expect(result.trades[0].buyOrderId).toBe('buy-1');
      expect(result.trades[0].sellOrderId).toBe('sell-1');
    });

    it('should set correct buyer/seller based on order side (sell order)', () => {
      const buyerAddress = 'GBUYER1234567890123456789012345678901234567890123456';
      orderBook.addOrder(createBookOrder('buy-1', 'bid', 0.50, 100, 1000, buyerAddress));

      const sellerAddress = 'GSELLER234567890123456789012345678901234567890123456';
      const sellOrder = createMatchingOrder('sell-1', 'SELL', 0.50, 100, sellerAddress);

      const result = matchOrder(sellOrder, orderBook);

      expect(result.trades[0].buyerAddress).toBe(buyerAddress);
      expect(result.trades[0].sellerAddress).toBe(sellerAddress);
      expect(result.trades[0].buyOrderId).toBe('buy-1');
      expect(result.trades[0].sellOrderId).toBe('sell-1');
    });

    it('should use maker price as execution price', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.40, 100, 1000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.60, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades[0].price).toBe(0.40); // Maker's price, not taker's
    });

    it('should generate unique trade IDs', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.45, 50, 1000));
      orderBook.addOrder(createBookOrder('sell-2', 'ask', 0.50, 50, 2000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades[0].id).not.toBe(result.trades[1].id);
      expect(result.trades[0].id).toMatch(/^trade_/);
      expect(result.trades[1].id).toMatch(/^trade_/);
    });

    it('should include correct marketId and outcome in trades', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.50, 100, 1000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.trades[0].marketId).toBe(marketId);
      expect(result.trades[0].outcome).toBe('YES');
    });
  });

  describe('Performance', () => {
    it('should efficiently match against 100+ orders in book', () => {
      // Add 100 sell orders at different prices
      for (let i = 0; i < 100; i++) {
        orderBook.addOrder(createBookOrder(
          `sell-${i}`,
          'ask',
          0.01 + (i * 0.009),
          10,
          i
        ));
      }

      const start = performance.now();

      // Buy order that will match all orders
      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.99, 1000);
      const result = matchOrder(buyOrder, orderBook);

      const duration = performance.now() - start;

      expect(result.trades.length).toBe(100);
      expect(duration).toBeLessThan(50); // Should be fast
    });

    it('should handle large quantity matches efficiently', () => {
      // Single large order
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.50, 1000000, 1000));

      const start = performance.now();

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 500000);
      const result = matchOrder(buyOrder, orderBook);

      const duration = performance.now() - start;

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].quantity).toBe(500000);
      expect(duration).toBeLessThan(10);
    });
  });

  describe('Position Deltas', () => {
    it('should calculate position deltas for buyer and seller on YES trade', () => {
      const sellerAddress = 'GSELLER234567890123456789012345678901234567890123456';
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.50, 100, 1000, sellerAddress));

      const buyerAddress = 'GBUYER1234567890123456789012345678901234567890123456';
      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100, buyerAddress);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.positionDeltas.length).toBe(2);

      const buyerDelta = result.positionDeltas.find(d => d.userAddress === buyerAddress);
      const sellerDelta = result.positionDeltas.find(d => d.userAddress === sellerAddress);

      expect(buyerDelta).toBeDefined();
      expect(buyerDelta?.yesSharesDelta).toBe(100);
      expect(buyerDelta?.noSharesDelta).toBe(0);

      expect(sellerDelta).toBeDefined();
      expect(sellerDelta?.yesSharesDelta).toBe(-100);
      expect(sellerDelta?.noSharesDelta).toBe(0);
    });

    it('should calculate position deltas for NO outcome trades', () => {
      const noOutcomeBook = new OrderBook(marketId, 1); // NO outcome

      const sellerAddress = 'GSELLER234567890123456789012345678901234567890123456';
      noOutcomeBook.addOrder({
        id: 'sell-1',
        userAddress: sellerAddress,
        side: 'ask',
        price: 0.50,
        quantity: 100,
        timestamp: 1000,
        marketId,
        outcome: 1,
      });

      const buyerAddress = 'GBUYER1234567890123456789012345678901234567890123456';
      const buyOrder: MatchingOrder = {
        id: 'buy-1',
        userAddress: buyerAddress,
        side: 'BUY',
        price: 0.50,
        quantity: 100,
        marketId,
        outcome: 'NO',
        timestamp: Date.now(),
      };

      const result = matchOrder(buyOrder, noOutcomeBook);

      const buyerDelta = result.positionDeltas.find(d => d.userAddress === buyerAddress);
      const sellerDelta = result.positionDeltas.find(d => d.userAddress === sellerAddress);

      expect(buyerDelta?.yesSharesDelta).toBe(0);
      expect(buyerDelta?.noSharesDelta).toBe(100);

      expect(sellerDelta?.yesSharesDelta).toBe(0);
      expect(sellerDelta?.noSharesDelta).toBe(-100);
    });

    it('should aggregate position deltas across multiple trades', () => {
      const seller1 = 'GSELLER1234567890123456789012345678901234567890123456';
      const seller2 = 'GSELLER2234567890123456789012345678901234567890123456';

      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.45, 50, 1000, seller1));
      orderBook.addOrder(createBookOrder('sell-2', 'ask', 0.50, 50, 2000, seller2));

      const buyerAddress = 'GBUYER1234567890123456789012345678901234567890123456';
      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100, buyerAddress);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.positionDeltas.length).toBe(3);

      const buyerDelta = result.positionDeltas.find(d => d.userAddress === buyerAddress);
      expect(buyerDelta?.yesSharesDelta).toBe(100);

      const seller1Delta = result.positionDeltas.find(d => d.userAddress === seller1);
      expect(seller1Delta?.yesSharesDelta).toBe(-50);

      const seller2Delta = result.positionDeltas.find(d => d.userAddress === seller2);
      expect(seller2Delta?.yesSharesDelta).toBe(-50);
    });

    it('should return empty position deltas when no trades occur', () => {
      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.positionDeltas.length).toBe(0);
    });

    it('should handle same user trading with multiple counterparties', () => {
      const seller = 'GSELLER1234567890123456789012345678901234567890123456';
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.45, 30, 1000, seller));
      orderBook.addOrder(createBookOrder('sell-2', 'ask', 0.50, 70, 2000, seller));

      const buyerAddress = 'GBUYER1234567890123456789012345678901234567890123456';
      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100, buyerAddress);

      const result = matchOrder(buyOrder, orderBook);

      expect(result.positionDeltas.length).toBe(2);

      const sellerDelta = result.positionDeltas.find(d => d.userAddress === seller);
      expect(sellerDelta?.yesSharesDelta).toBe(-100);
    });
  });

  describe('Atomicity', () => {
    it('should return consistent result with trades and position deltas', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.45, 30, 1000));
      orderBook.addOrder(createBookOrder('sell-2', 'ask', 0.50, 70, 2000));

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);
      const result = matchOrder(buyOrder, orderBook);

      const totalTradeQty = result.trades.reduce((sum, t) => sum + t.quantity, 0);
      expect(totalTradeQty).toBe(100);

      expect(result.positionDeltas.length).toBeGreaterThan(0);
      expect(orderBook.getOrderCount()).toBe(0);
    });

    it('should leave order book unchanged when there are no matches', () => {
      orderBook.addOrder(createBookOrder('sell-1', 'ask', 0.70, 100, 1000));

      const initialOrderCount = orderBook.getOrderCount();
      const initialBestAsk = orderBook.getBestAsk();

      const buyOrder = createMatchingOrder('buy-1', 'BUY', 0.50, 100);
      matchOrder(buyOrder, orderBook);

      expect(orderBook.getOrderCount()).toBe(initialOrderCount);
      expect(orderBook.getBestAsk()?.quantity).toBe(initialBestAsk?.quantity);
    });
  });

  describe('outcomeToNumber', () => {
    it('should convert YES to 0', () => {
      expect(outcomeToNumber('YES')).toBe(0);
    });

    it('should convert NO to 1', () => {
      expect(outcomeToNumber('NO')).toBe(1);
    });
  });
});
