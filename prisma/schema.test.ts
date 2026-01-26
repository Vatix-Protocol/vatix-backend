import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { Pool } from "pg";
import {
  getTestPrismaClient,
  getTestPool,
  cleanDatabase,
  disconnectTestPrisma,
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../tests/helpers/test-database";

describe("Database Schema Tests", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let testMarketId: string;
  const testUserAddress = "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLM";
  const testOracleAddress = "GZYXWVUTSRQPONMLKJIHGFEDCBA0987654321ZYXWVUTSRQP";

  beforeAll(async () => {
    await acquireDatabaseLock();
    prisma = getTestPrismaClient();
    pool = getTestPool();
  });

  afterAll(async () => {
    await releaseDatabaseLock();
    await disconnectTestPrisma();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  describe("Table Existence Verification", () => {
    it("should verify all required tables exist", async () => {
      const result = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        ORDER BY table_name;
      `);

      const tableNames = result.rows.map((row) => row.table_name);

      expect(tableNames).toContain("markets");
      expect(tableNames).toContain("orders");
      expect(tableNames).toContain("user_positions");
      expect(tableNames).toContain("_prisma_migrations");
      expect(tableNames.length).toBeGreaterThanOrEqual(4);
    });

    it("should verify all enums exist", async () => {
      const result = await pool.query(`
        SELECT typname
        FROM pg_type
        WHERE typtype = 'e'
        ORDER BY typname;
      `);

      const enumNames = result.rows.map((row) => row.typname);

      expect(enumNames).toContain("MarketStatus");
      expect(enumNames).toContain("OrderSide");
      expect(enumNames).toContain("OrderStatus");
      expect(enumNames).toContain("Outcome");
    });

    it("should verify markets table columns", async () => {
      const result = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'markets'
        ORDER BY ordinal_position;
      `);

      const columns = result.rows.map((row) => row.column_name);

      expect(columns).toContain("id");
      expect(columns).toContain("question");
      expect(columns).toContain("end_time");
      expect(columns).toContain("resolution_time");
      expect(columns).toContain("oracle_address");
      expect(columns).toContain("status");
      expect(columns).toContain("outcome");
      expect(columns).toContain("created_at");
      expect(columns).toContain("updated_at");
    });

    it("should verify orders table columns", async () => {
      const result = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'orders'
        ORDER BY ordinal_position;
      `);

      const columns = result.rows.map((row) => row.column_name);

      expect(columns).toContain("id");
      expect(columns).toContain("market_id");
      expect(columns).toContain("user_address");
      expect(columns).toContain("side");
      expect(columns).toContain("outcome");
      expect(columns).toContain("price");
      expect(columns).toContain("quantity");
      expect(columns).toContain("filled_quantity");
      expect(columns).toContain("status");
      expect(columns).toContain("created_at");
    });

    it("should verify user_positions table columns", async () => {
      const result = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'user_positions'
        ORDER BY ordinal_position;
      `);

      const columns = result.rows.map((row) => row.column_name);

      expect(columns).toContain("id");
      expect(columns).toContain("market_id");
      expect(columns).toContain("user_address");
      expect(columns).toContain("yes_shares");
      expect(columns).toContain("no_shares");
      expect(columns).toContain("locked_collateral");
      expect(columns).toContain("is_settled");
      expect(columns).toContain("updated_at");
    });
  });

  describe("Index Verification", () => {
    it("should verify markets table indexes", async () => {
      const result = await pool.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'markets'
        ORDER BY indexname;
      `);

      const indexes = result.rows.map((row) => row.indexname);

      expect(indexes).toContain("markets_pkey");
      expect(indexes).toContain("markets_status_idx");
      expect(indexes).toContain("markets_end_time_idx");
      expect(indexes).toContain("markets_status_end_time_idx");
    });

    it("should verify orders table indexes", async () => {
      const result = await pool.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'orders'
        ORDER BY indexname;
      `);

      const indexes = result.rows.map((row) => row.indexname);

      expect(indexes).toContain("orders_pkey");
      expect(indexes).toContain("orders_market_id_idx");
      expect(indexes).toContain("orders_user_address_idx");
      expect(indexes).toContain("orders_status_idx");
      expect(indexes).toContain("orders_market_id_outcome_price_created_at_idx");
    });

    it("should verify user_positions table indexes", async () => {
      const result = await pool.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'user_positions'
        ORDER BY indexname;
      `);

      const indexes = result.rows.map((row) => row.indexname);

      expect(indexes).toContain("user_positions_pkey");
      expect(indexes).toContain("user_positions_market_id_idx");
      expect(indexes).toContain("user_positions_user_address_idx");
      expect(indexes).toContain("user_positions_market_id_user_address_key");
    });
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

      expect(activeMarkets.length).toBe(1);
      expect(activeMarkets[0].question).toBe("Active market 1");
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

    it("should update order status and filled quantity", async () => {
      const order = await prisma.order.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          side: "BUY",
          outcome: "YES",
          price: 0.6,
          quantity: 100,
          status: "OPEN",
        },
      });

      const updated = await prisma.order.update({
        where: { id: order.id },
        data: {
          filledQuantity: 50,
          status: "PARTIALLY_FILLED",
        },
      });

      expect(updated.filledQuantity).toBe(50);
      expect(updated.status).toBe("PARTIALLY_FILLED");
    });

    it("should retrieve orders by market and outcome", async () => {
      await prisma.order.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          side: "BUY",
          outcome: "YES",
          price: 0.6,
          quantity: 100,
          status: "OPEN",
        },
      });

      await prisma.order.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          side: "SELL",
          outcome: "NO",
          price: 0.4,
          quantity: 50,
          status: "OPEN",
        },
      });

      const yesOrders = await prisma.order.findMany({
        where: {
          marketId: testMarketId,
          outcome: "YES",
        },
      });

      expect(yesOrders.length).toBe(1);
      expect(yesOrders[0].outcome).toBe("YES");
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

    it("should update position shares and collateral", async () => {
      const position = await prisma.userPosition.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          yesShares: 100,
          noShares: 0,
          lockedCollateral: 60.0,
        },
      });

      const updated = await prisma.userPosition.update({
        where: { id: position.id },
        data: {
          yesShares: 150,
          lockedCollateral: 90.0,
        },
      });

      expect(updated.yesShares).toBe(150);
      expect(updated.lockedCollateral.toString()).toBe("90");
    });

    it("should retrieve position by market and user", async () => {
      await prisma.userPosition.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          yesShares: 100,
          noShares: 0,
          lockedCollateral: 60.0,
        },
      });

      const position = await prisma.userPosition.findUnique({
        where: {
          marketId_userAddress: {
            marketId: testMarketId,
            userAddress: testUserAddress,
          },
        },
      });

      expect(position).toBeDefined();
      expect(position?.yesShares).toBe(100);
    });
  });

  describe("Foreign Key Constraints", () => {
    it("should prevent creating order without valid market", async () => {
      await expect(
        prisma.order.create({
          data: {
            marketId: "non-existent-market-id",
            userAddress: testUserAddress,
            side: "BUY",
            outcome: "YES",
            price: 0.5,
            quantity: 10,
            status: "OPEN",
          },
        }),
      ).rejects.toThrow();
    });

    it("should prevent creating user position without valid market", async () => {
      await expect(
        prisma.userPosition.create({
          data: {
            marketId: "non-existent-market-id",
            userAddress: testUserAddress,
            yesShares: 100,
            noShares: 0,
            lockedCollateral: 60.0,
          },
        }),
      ).rejects.toThrow();
    });

    it("should allow creating order with valid market", async () => {
      const market = await prisma.market.create({
        data: {
          question: "Test market",
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

      expect(order.marketId).toBe(market.id);
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

    it("should delete user positions when market is deleted", async () => {
      const market = await prisma.market.create({
        data: {
          question: "Test market for cascade delete",
          endTime: new Date("2025-12-31T23:59:59Z"),
          oracleAddress: testOracleAddress,
          status: "ACTIVE",
        },
      });

      const position = await prisma.userPosition.create({
        data: {
          marketId: market.id,
          userAddress: testUserAddress,
          yesShares: 10,
          noShares: 0,
          lockedCollateral: 5.0,
        },
      });

      await prisma.market.delete({
        where: { id: market.id },
      });

      const deletedPosition = await prisma.userPosition.findUnique({
        where: { id: position.id },
      });

      expect(deletedPosition).toBeNull();
    });

    it("should delete both orders and positions when market is deleted", async () => {
      const market = await prisma.market.create({
        data: {
          question: "Test market for full cascade delete",
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

      const position = await prisma.userPosition.create({
        data: {
          marketId: market.id,
          userAddress: testUserAddress,
          yesShares: 10,
          noShares: 0,
          lockedCollateral: 5.0,
        },
      });

      // Verify they exist before deletion
      expect(await prisma.order.findUnique({ where: { id: order.id } })).not.toBeNull();
      expect(
        await prisma.userPosition.findUnique({ where: { id: position.id } }),
      ).not.toBeNull();

      // Delete market
      await prisma.market.delete({
        where: { id: market.id },
      });

      // Verify cascade deletion
      expect(await prisma.order.findUnique({ where: { id: order.id } })).toBeNull();
      expect(
        await prisma.userPosition.findUnique({ where: { id: position.id } }),
      ).toBeNull();
    });
  });

  describe("Data Types and Constraints", () => {
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

    it("should handle decimal precision for order prices", async () => {
      const order = await prisma.order.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          side: "BUY",
          outcome: "YES",
          price: 0.12345678, // 8 decimal places
          quantity: 100,
          status: "OPEN",
        },
      });

      expect(order.price.toString()).toBe("0.12345678");
    });

    it("should handle decimal precision for locked collateral", async () => {
      const position = await prisma.userPosition.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          yesShares: 100,
          noShares: 0,
          lockedCollateral: 1234567.12345678, // Large number with 8 decimals
        },
      });

      expect(position.lockedCollateral.toString()).toBe("1234567.12345678");
    });

    it("should enforce varchar length for addresses", async () => {
      const validAddress = "G" + "A".repeat(55); // 56 characters total

      const position = await prisma.userPosition.create({
        data: {
          marketId: testMarketId,
          userAddress: validAddress,
          yesShares: 10,
          noShares: 0,
          lockedCollateral: 5.0,
        },
      });

      expect(position.userAddress).toBe(validAddress);
      expect(position.userAddress.length).toBe(56);
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
      expect(market.updatedAt).toBeInstanceOf(Date);
    });

    it("should apply default values for order", async () => {
      const order = await prisma.order.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
          side: "BUY",
          outcome: "YES",
          price: 0.5,
          quantity: 100,
        },
      });

      expect(order.filledQuantity).toBe(0);
      expect(order.status).toBe("OPEN");
      expect(order.createdAt).toBeInstanceOf(Date);
    });

    it("should apply default values for user position", async () => {
      const position = await prisma.userPosition.create({
        data: {
          marketId: testMarketId,
          userAddress: testUserAddress,
        },
      });

      expect(position.yesShares).toBe(0);
      expect(position.noShares).toBe(0);
      expect(position.lockedCollateral.toString()).toBe("0");
      expect(position.isSettled).toBe(false);
      expect(position.updatedAt).toBeInstanceOf(Date);
    });
  });
});
