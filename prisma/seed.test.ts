import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client';
import { seed } from './seed';
import {
  getTestPrismaClient,
  cleanDatabase,
  disconnectTestPrisma,
  acquireDatabaseLock,
  releaseDatabaseLock,
} from '../tests/helpers/test-database';

describe('Database Seed', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    await acquireDatabaseLock();
    prisma = getTestPrismaClient();
  });

  afterAll(async () => {
    await releaseDatabaseLock();
    await disconnectTestPrisma();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  describe('Seed Execution', () => {
    it('should run seed without errors', async () => {
      const result = await seed(prisma);

      expect(result).toBeDefined();
      expect(result.markets).toBeGreaterThan(0);
      expect(result.orders).toBeGreaterThan(0);
      expect(result.positions).toBeGreaterThan(0);
    });

    it('should create expected number of markets', async () => {
      await seed(prisma);

      const markets = await prisma.market.findMany();
      expect(markets.length).toBe(5);
    });

    it('should create markets with different statuses', async () => {
      await seed(prisma);

      const activeMarkets = await prisma.market.findMany({
        where: { status: 'ACTIVE' },
      });
      const resolvedMarkets = await prisma.market.findMany({
        where: { status: 'RESOLVED' },
      });
      const cancelledMarkets = await prisma.market.findMany({
        where: { status: 'CANCELLED' },
      });

      expect(activeMarkets.length).toBeGreaterThan(0);
      expect(resolvedMarkets.length).toBeGreaterThan(0);
      expect(cancelledMarkets.length).toBeGreaterThan(0);
    });
  });

  describe('Data Validity', () => {
    it('should create markets with valid data', async () => {
      await seed(prisma);

      const markets = await prisma.market.findMany();

      for (const market of markets) {
        expect(market.question).toBeTruthy();
        expect(market.endTime).toBeInstanceOf(Date);
        expect(market.oracleAddress).toHaveLength(56);
        expect(market.oracleAddress.startsWith('G')).toBe(true);
        expect(['ACTIVE', 'RESOLVED', 'CANCELLED']).toContain(market.status);
      }
    });

    it('should create resolved markets with outcome and resolution time', async () => {
      await seed(prisma);

      const resolvedMarkets = await prisma.market.findMany({
        where: { status: 'RESOLVED' },
      });

      for (const market of resolvedMarkets) {
        expect(market.outcome).not.toBeNull();
        expect(market.resolutionTime).toBeInstanceOf(Date);
      }
    });

    it('should create orders with valid constraints', async () => {
      await seed(prisma);

      const orders = await prisma.order.findMany();

      for (const order of orders) {
        expect(order.userAddress).toHaveLength(56);
        expect(order.userAddress.startsWith('G')).toBe(true);
        expect(['BUY', 'SELL']).toContain(order.side);
        expect(['YES', 'NO']).toContain(order.outcome);
        expect(Number(order.price)).toBeGreaterThan(0);
        expect(Number(order.price)).toBeLessThan(1);
        expect(order.quantity).toBeGreaterThan(0);
        expect(order.filledQuantity).toBeGreaterThanOrEqual(0);
        expect(order.filledQuantity).toBeLessThanOrEqual(order.quantity);
        expect(['OPEN', 'FILLED', 'CANCELLED', 'PARTIALLY_FILLED']).toContain(
          order.status
        );
      }
    });

    it('should create positions with valid data', async () => {
      await seed(prisma);

      const positions = await prisma.userPosition.findMany();

      for (const position of positions) {
        expect(position.userAddress).toHaveLength(56);
        expect(position.userAddress.startsWith('G')).toBe(true);
        expect(position.yesShares).toBeGreaterThanOrEqual(0);
        expect(position.noShares).toBeGreaterThanOrEqual(0);
        expect(Number(position.lockedCollateral)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Idempotency', () => {
    it('should be idempotent - running twice produces same result', async () => {
      // Run seed first time
      const firstResult = await seed(prisma);

      // Run seed second time
      const secondResult = await seed(prisma);

      // Results should be identical
      expect(secondResult.markets).toBe(firstResult.markets);
      expect(secondResult.orders).toBe(firstResult.orders);
      expect(secondResult.positions).toBe(firstResult.positions);

      // Database should have same counts
      const marketCount = await prisma.market.count();
      const orderCount = await prisma.order.count();
      const positionCount = await prisma.userPosition.count();

      expect(marketCount).toBe(firstResult.markets);
      expect(orderCount).toBe(firstResult.orders);
      expect(positionCount).toBe(firstResult.positions);
    });

    it('should clear existing data before seeding', async () => {
      // Create some initial data
      const market = await prisma.market.create({
        data: {
          question: 'Test question to be deleted',
          endTime: new Date('2030-01-01'),
          oracleAddress:
            'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ',
          status: 'ACTIVE',
        },
      });

      // Run seed
      await seed(prisma);

      // Original market should be gone
      const foundMarket = await prisma.market.findUnique({
        where: { id: market.id },
      });
      expect(foundMarket).toBeNull();

      // Only seeded data should exist
      const allMarkets = await prisma.market.findMany();
      expect(allMarkets.every((m) => m.question !== 'Test question to be deleted')).toBe(true);
    });
  });

  describe('Relationships', () => {
    it('should create orders linked to valid markets', async () => {
      await seed(prisma);

      const orders = await prisma.order.findMany({
        include: { market: true },
      });

      for (const order of orders) {
        expect(order.market).toBeDefined();
        expect(order.marketId).toBe(order.market.id);
      }
    });

    it('should create positions linked to valid markets', async () => {
      await seed(prisma);

      const positions = await prisma.userPosition.findMany({
        include: { market: true },
      });

      for (const position of positions) {
        expect(position.market).toBeDefined();
        expect(position.marketId).toBe(position.market.id);
      }
    });

    it('should not create orders for cancelled markets', async () => {
      await seed(prisma);

      const cancelledMarkets = await prisma.market.findMany({
        where: { status: 'CANCELLED' },
        include: { orders: true },
      });

      for (const market of cancelledMarkets) {
        expect(market.orders.length).toBe(0);
      }
    });

    it('should create positions for all markets', async () => {
      await seed(prisma);

      const markets = await prisma.market.findMany({
        include: { positions: true },
      });

      for (const market of markets) {
        expect(market.positions.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Constraints', () => {
    it('should respect unique constraint on user positions', async () => {
      await seed(prisma);

      // Check that there are no duplicate (marketId, userAddress) pairs
      const positions = await prisma.userPosition.findMany();
      const uniquePairs = new Set(
        positions.map((p) => `${p.marketId}-${p.userAddress}`)
      );

      expect(uniquePairs.size).toBe(positions.length);
    });

    it('should create orders with mix of BUY and SELL sides', async () => {
      await seed(prisma);

      const buyOrders = await prisma.order.findMany({
        where: { side: 'BUY' },
      });
      const sellOrders = await prisma.order.findMany({
        where: { side: 'SELL' },
      });

      expect(buyOrders.length).toBeGreaterThan(0);
      expect(sellOrders.length).toBeGreaterThan(0);
    });

    it('should create orders with mix of YES and NO outcomes', async () => {
      await seed(prisma);

      const yesOrders = await prisma.order.findMany({
        where: { outcome: 'YES' },
      });
      const noOrders = await prisma.order.findMany({
        where: { outcome: 'NO' },
      });

      expect(yesOrders.length).toBeGreaterThan(0);
      expect(noOrders.length).toBeGreaterThan(0);
    });

    it('should create orders with different statuses', async () => {
      await seed(prisma);

      const openOrders = await prisma.order.findMany({
        where: { status: 'OPEN' },
      });
      const filledOrders = await prisma.order.findMany({
        where: { status: 'FILLED' },
      });
      const partiallyFilledOrders = await prisma.order.findMany({
        where: { status: 'PARTIALLY_FILLED' },
      });

      expect(openOrders.length).toBeGreaterThan(0);
      expect(filledOrders.length).toBeGreaterThan(0);
      expect(partiallyFilledOrders.length).toBeGreaterThan(0);
    });

    it('should mark positions as settled for resolved markets', async () => {
      await seed(prisma);

      const resolvedMarkets = await prisma.market.findMany({
        where: { status: 'RESOLVED' },
        include: { positions: true },
      });

      for (const market of resolvedMarkets) {
        for (const position of market.positions) {
          expect(position.isSettled).toBe(true);
        }
      }
    });

    it('should mark positions as unsettled for active markets', async () => {
      await seed(prisma);

      const activeMarkets = await prisma.market.findMany({
        where: { status: 'ACTIVE' },
        include: { positions: true },
      });

      for (const market of activeMarkets) {
        for (const position of market.positions) {
          expect(position.isSettled).toBe(false);
        }
      }
    });
  });

  describe('Sample Markets Content', () => {
    it('should create BTC market as specified', async () => {
      await seed(prisma);

      const btcMarket = await prisma.market.findFirst({
        where: { question: { contains: 'BTC reach $100k' } },
      });

      expect(btcMarket).toBeDefined();
      expect(btcMarket?.status).toBe('ACTIVE');
    });

    it('should create ETH market as specified', async () => {
      await seed(prisma);

      const ethMarket = await prisma.market.findFirst({
        where: { question: { contains: 'ETH flip BTC' } },
      });

      expect(ethMarket).toBeDefined();
      expect(ethMarket?.status).toBe('ACTIVE');
    });

    it('should create SOL market as resolved with outcome false', async () => {
      await seed(prisma);

      const solMarket = await prisma.market.findFirst({
        where: { question: { contains: 'SOL reach $200' } },
      });

      expect(solMarket).toBeDefined();
      expect(solMarket?.status).toBe('RESOLVED');
      expect(solMarket?.outcome).toBe(false);
    });
  });
});
