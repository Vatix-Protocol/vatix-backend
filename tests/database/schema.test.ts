import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

describe("Database Schema Tests", () => {
  let testMarketId: string;
  let prisma: PrismaClient;
  let pool: Pool;
  const testUserAddress = "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLM";
  const testOracleAddress = "GZYXWVUTSRQPONMLKJIHGFEDCBA0987654321ZYXWVUTSRQP";

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5433/vatix",
    });

    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  describe("Market Model", () => {
    it("should insert a market with valid fields", async () => {
      const market = await prisma.market.create({
        data: {
          question: "Will it rain tomorrow?",
          endTime: new Date("2025-12-31T23:59:59Z"),
          oracleAddress: testOracleAddress,
          status: "ACTIVE",
        },
      });

      expect(market.id).toBeDefined();
      expect(market.question).toBe("Will it rain tomorrow?");
      expect(market.status).toBe("ACTIVE");
      expect(market.outcome).toBeNull();
      expect(market.resolutionTime).toBeNull();
      expect(market.createdAt).toBeInstanceOf(Date);
      expect(market.updatedAt).toBeInstanceOf(Date);

      testMarketId = market.id;
    });
  });

  describe("Order Model", () => {
    it("should insert multiple orders linked to the market", async () => {
      const order1 = await prisma.order.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          side: "BUY",
          outcome: "YES",
          price: 0.65,
          quantity: 100,
          status: "OPEN",
        },
      });

      const order2 = await prisma.order.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          side: "SELL",
          outcome: "NO",
          price: 0.35,
          quantity: 50,
          status: "OPEN",
        },
      });

      expect(order1.id).toBeDefined();
      expect(order1.marketId).toBe(testMarketId);
      expect(order1.side).toBe("BUY");
      expect(order1.outcome).toBe("YES");
      expect(order1.price.toString()).toBe("0.65");
      expect(order1.quantity).toBe(100);
      expect(order1.filledQuantity).toBe(0);
      expect(order1.status).toBe("OPEN");

      expect(order2.id).toBeDefined();
      expect(order2.marketId).toBe(testMarketId);
      expect(order2.side).toBe("SELL");
      expect(order2.outcome).toBe("NO");
      expect(order2.price.toString()).toBe("0.35");
      expect(order2.quantity).toBe(50);
      expect(order2.filledQuantity).toBe(0);
      expect(order2.status).toBe("OPEN");
    });

    it("should verify relation integrity with market", async () => {
      const marketWithOrders = await prisma.market.findUnique({
        where: { id: testMarketId },
        include: { orders: true },
      });

      expect(marketWithOrders).toBeDefined();
      expect(marketWithOrders?.orders.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("UserPosition Model", () => {
    it("should create one user position per market + user", async () => {
      const position = await prisma.userPosition.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          yesShares: 100,
          noShares: 0,
          lockedCollateral: 65.0,
          isSettled: false,
        },
      });

      expect(position.id).toBeDefined();
      expect(position.marketId).toBe(testMarketId);
      expect(position.userAddress).toBe(testUserAddress);
      expect(position.yesShares).toBe(100);
      expect(position.noShares).toBe(0);
      expect(position.lockedCollateral.toString()).toBe("65");
      expect(position.isSettled).toBe(false);
      expect(position.updatedAt).toBeInstanceOf(Date);
    });

    it("should enforce unique constraint on (marketId, userAddress)", async () => {
      await expect(
        prisma.userPosition.create({
          data: {
            marketId: testMarketId,
            userAddress: testUserAddress,
            yesShares: 50,
            noShares: 50,
            lockedCollateral: 50.0,
          },
        })
      ).rejects.toThrow();
    });
  });

  describe("Cascade Delete", () => {
    it("should delete orders and user positions when market is deleted", async () => {
      const marketToDelete = await prisma.market.create({
        data: {
          question: "Test market for cascade delete",
          endTime: new Date("2025-12-31T23:59:59Z"),
          oracleAddress: testOracleAddress,
          status: "ACTIVE",
        },
      });

      const orderToDelete = await prisma.order.create({
        data: {
          marketId: marketToDelete.id,
          userAddress: testUserAddress,
          side: "BUY",
          outcome: "YES",
          price: 0.5,
          quantity: 10,
          status: "OPEN",
        },
      });

      const positionToDelete = await prisma.userPosition.create({
        data: {
          marketId: marketToDelete.id,
          userAddress: testUserAddress,
          yesShares: 10,
          noShares: 0,
          lockedCollateral: 5.0,
        },
      });

      await prisma.market.delete({
        where: { id: marketToDelete.id },
      });

      const deletedOrder = await prisma.order.findUnique({
        where: { id: orderToDelete.id },
      });

      const deletedPosition = await prisma.userPosition.findUnique({
        where: { id: positionToDelete.id },
      });

      expect(deletedOrder).toBeNull();
      expect(deletedPosition).toBeNull();
    });
  });

  describe("Cleanup", () => {
    it("should clean up test data", async () => {
      await prisma.order.deleteMany({
        where: { marketId: testMarketId },
      });

      await prisma.userPosition.deleteMany({
        where: { marketId: testMarketId },
      });

      await prisma.market.delete({
        where: { id: testMarketId },
      });

      const deletedMarket = await prisma.market.findUnique({
        where: { id: testMarketId },
      });

      expect(deletedMarket).toBeNull();
    });
  });
});
