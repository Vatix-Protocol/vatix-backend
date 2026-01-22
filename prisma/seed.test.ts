/**
 * Tests for the seed script
 * 
 * These tests verify that the seed script:
 * - Can be imported
 * - Creates valid data structures
 * - Respects database constraints
 * - Is idempotent
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient, MarketStatus, OrderSide, OrderStatus, Outcome } from "../src/generated/prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { seed } from "./seed";

describe("Seed Script", () => {
  let prisma: PrismaClient;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/vatix",
    });

    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  beforeEach(async () => {
    // Clean up before each test
    await prisma.order.deleteMany();
    await prisma.userPosition.deleteMany();
    await prisma.market.deleteMany();
  });

  it("should export seed function", () => {
    expect(typeof seed).toBe("function");
  });

  it("should create markets successfully", async () => {
    await seed();

    const markets = await prisma.market.findMany();
    expect(markets.length).toBeGreaterThan(0);
    expect(markets.length).toBeLessThanOrEqual(5);

    // Verify market structure
    for (const market of markets) {
      expect(market.id).toBeDefined();
      expect(market.question).toBeTruthy();
      expect(market.endTime).toBeInstanceOf(Date);
      expect(market.oracleAddress).toHaveLength(56); // Stellar address length
      expect([MarketStatus.ACTIVE, MarketStatus.RESOLVED, MarketStatus.CANCELLED]).toContain(market.status);
    }
  });

  it("should create orders with valid constraints", async () => {
    await seed();

    const orders = await prisma.order.findMany();
    expect(orders.length).toBeGreaterThan(0);

    for (const order of orders) {
      expect(order.id).toBeDefined();
      expect(order.marketId).toBeDefined();
      expect(order.userAddress).toHaveLength(56); // Stellar address length
      expect([OrderSide.BUY, OrderSide.SELL]).toContain(order.side);
      expect([Outcome.YES, Outcome.NO]).toContain(order.outcome);
      expect(Number(order.price)).toBeGreaterThan(0);
      expect(Number(order.price)).toBeLessThanOrEqual(1);
      expect(order.quantity).toBeGreaterThan(0);
      expect(order.filledQuantity).toBeGreaterThanOrEqual(0);
      expect(order.filledQuantity).toBeLessThanOrEqual(order.quantity);
      expect([
        OrderStatus.OPEN,
        OrderStatus.FILLED,
        OrderStatus.CANCELLED,
        OrderStatus.PARTIALLY_FILLED,
      ]).toContain(order.status);

      // Verify market exists
      const market = await prisma.market.findUnique({
        where: { id: order.marketId },
      });
      expect(market).toBeDefined();
    }
  });

  it("should create positions correctly", async () => {
    await seed();

    const positions = await prisma.userPosition.findMany();
    expect(positions.length).toBeGreaterThan(0);

    for (const position of positions) {
      expect(position.id).toBeDefined();
      expect(position.marketId).toBeDefined();
      expect(position.userAddress).toHaveLength(56); // Stellar address length
      expect(position.yesShares).toBeGreaterThanOrEqual(0);
      expect(position.noShares).toBeGreaterThanOrEqual(0);
      expect(Number(position.lockedCollateral)).toBeGreaterThanOrEqual(0);

      // Verify market exists
      const market = await prisma.market.findUnique({
        where: { id: position.marketId },
      });
      expect(market).toBeDefined();
    }
  });

  it("should be idempotent (can run multiple times)", async () => {
    // Run seed twice
    await seed();
    const firstRun = {
      markets: await prisma.market.count(),
      orders: await prisma.order.count(),
      positions: await prisma.userPosition.count(),
    };

    await seed();
    const secondRun = {
      markets: await prisma.market.count(),
      orders: await prisma.order.count(),
      positions: await prisma.userPosition.count(),
    };

    // Should have same counts (idempotent)
    expect(secondRun.markets).toBe(firstRun.markets);
    expect(secondRun.orders).toBe(firstRun.orders);
    expect(secondRun.positions).toBe(firstRun.positions);
  });

  it("should create markets with different statuses", async () => {
    await seed();

    const markets = await prisma.market.findMany();
    const statuses = markets.map((m) => m.status);

    // Should have at least one ACTIVE market
    expect(statuses).toContain(MarketStatus.ACTIVE);

    // Should have at least one RESOLVED market
    const resolvedMarkets = markets.filter((m) => m.status === MarketStatus.RESOLVED);
    expect(resolvedMarkets.length).toBeGreaterThan(0);

    // RESOLVED markets should have an outcome
    for (const market of resolvedMarkets) {
      expect(market.outcome).not.toBeNull();
      expect(market.resolutionTime).not.toBeNull();
    }
  });

  it("should create orders with mix of BUY/SELL and YES/NO", async () => {
    await seed();

    const orders = await prisma.order.findMany();
    const sides = new Set(orders.map((o) => o.side));
    const outcomes = new Set(orders.map((o) => o.outcome));

    expect(sides.has(OrderSide.BUY)).toBe(true);
    expect(sides.has(OrderSide.SELL)).toBe(true);
    expect(outcomes.has(Outcome.YES)).toBe(true);
    expect(outcomes.has(Outcome.NO)).toBe(true);
  });

  it("should respect unique constraint on user positions", async () => {
    await seed();

    const positions = await prisma.userPosition.findMany();
    const positionKeys = positions.map((p) => `${p.marketId}-${p.userAddress}`);

    // Each market-user combination should be unique
    expect(new Set(positionKeys).size).toBe(positionKeys.length);
  });

  it("should have realistic price ranges (0-1)", async () => {
    await seed();

    const orders = await prisma.order.findMany();
    for (const order of orders) {
      const price = Number(order.price);
      expect(price).toBeGreaterThan(0);
      expect(price).toBeLessThanOrEqual(1);
    }
  });
});
