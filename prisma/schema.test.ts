import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";

describe("Database Schema Tests", () => {
  let prisma: PrismaClient;
  let testMarketId: string;
  const testUserAddress = "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLM";
  const testOracleAddress = "GZYXWVUTSRQPONMLKJIHGFEDCBA0987654321ZYXWVUTSRQP";

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up test data before each test
    await prisma.order.deleteMany();
    await prisma.userPosition.deleteMany();
    await prisma.market.deleteMany();
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

    it("should update market status to RESOLVED", async () => {
      const market = await prisma.market.create({
        data: {
          question: "Test market for resolution",
          endTime: new Date("2025-12-31T23:59:59Z"),
          oracleAddress: testOracleAddress,
          status: "ACTIVE",
        },
      });

      const updated = await prisma.market.update({
        where: { id: market.id },
        data: {
          status: "RESOLVED",
          outcome: true,
          resolutionTime: new Date(),
        },
      });

      expect(updated.status).toBe("RESOLVED");
      expect(updated.outcome).toBe(true);
      expect(updated.resolutionTime).toBeInstanceOf(Date);
    });

    it("should retrieve markets by status", async () => {
      await prisma.market.create({
        data: {
          question: "Active market 1",
          endTime: new Date("2025-12-31T23:59:59Z"),
          oracleAddress: testOracleAddress,
          status: "ACTIVE",
        },
      });

      await prisma.market.create({
        data: {
          question: "Resolved market",
          endTime: new Date("2025-12-31T23:59:59Z"),
          oracleAddress: testOracleAddress,
          status: "RESOLVED",
          outcome: true,
        },
      });

      const activeMarkets = await prisma.market.findMany({
        where: { status: "ACTIVE" },
      });

      expect(activeMarkets.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Order Model", () => {
    beforeEach(async () => {
      const market = await prisma.market.create({
        data: {
          question: "Test market for orders",
          endTime: new Date("2025-12-31T23:59:59Z"),
          oracleAddress: testOracleAddress,
          status: "ACTIVE",
        },
      });
      testMarketId = market.id;
    });

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
      expect(order1.status).toBe("OPEN");
      expect(order2.id).toBeDefined();
    });

    it("should verify relation integrity with market", async () => {
      await prisma.order.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          side: "BUY",
          outcome: "YES",
          price: 0.5,
          quantity: 10,
          status: "OPEN",
        },
      });

      const marketWithOrders = await prisma.market.findUnique({
        where: { id: testMarketId },
        include: { orders: true },
      });

      expect(marketWithOrders).toBeDefined();
      expect(marketWithOrders?.orders.length).toBe(1);
    });
  });

  describe("UserPosition Model", () => {
    beforeEach(async () => {
      const market = await prisma.market.create({
        data: {
          question: "Test market for positions",
          endTime: new Date("2025-12-31T23:59:59Z"),
          oracleAddress: testOracleAddress,
          status: "ACTIVE",
        },
      });
      testMarketId = market.id;
    });

    it("should create one user position per market + user", async () => {
      const position = await prisma.userPosition.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          yesShares: 100,
          noShares: 0,
          lockedCollateral: 65, // SQLite treats this as integer or float loosely
          isSettled: false,
        },
      });

      expect(position.id).toBeDefined();
      expect(position.marketId).toBe(testMarketId);
      expect(position.updatedAt).toBeInstanceOf(Date);
    });

    it("should enforce unique constraint on (marketId, userAddress)", async () => {
      await prisma.userPosition.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          yesShares: 100,
          noShares: 0,
          lockedCollateral: 65.0,
        },
      });

      await expect(
        prisma.userPosition.create({
          data: {
            marketId: testMarketId,
            userAddress: testUserAddress,
            yesShares: 50,
            noShares: 50,
            lockedCollateral: 50.0,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("Cascade Deletion", () => {
    it("should delete orders when market is deleted", async () => {
      const market = await prisma.market.create({
        data: {
          question: "Test market for cascade delete",
          endTime: new Date("2025-12-31T23:59:59Z"),
          oracleAddress: testOracleAddress,
          status: "ACTIVE",
        },
      });

      const order = await prisma.order.create({
        data: {
          marketId: market.id,
          userAddress: testUserAddress,
          side: "BUY",
          outcome: "YES",
          price: 0.5,
          quantity: 10,
          status: "OPEN",
        },
      });

      await prisma.market.delete({
        where: { id: market.id },
      });

      const deletedOrder = await prisma.order.findUnique({
        where: { id: order.id },
      });

      expect(deletedOrder).toBeNull();
    });
  });

  describe("Default Values", () => {
    beforeEach(async () => {
      const market = await prisma.market.create({
        data: {
          question: "Test market",
          endTime: new Date("2025-12-31T23:59:59Z"),
          oracleAddress: testOracleAddress,
          status: "ACTIVE",
        },
      });
      testMarketId = market.id;
    });

    it("should apply default values for market", async () => {
      const market = await prisma.market.create({
        data: {
          question: "Test defaults",
          endTime: new Date("2025-12-31T23:59:59Z"),
          oracleAddress: testOracleAddress,
        },
      });

      expect(market.status).toBe("ACTIVE");
      expect(market.outcome).toBeNull();
      expect(market.resolutionTime).toBeNull();
      expect(market.createdAt).toBeInstanceOf(Date);
    });
  });
});
