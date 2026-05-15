import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import positionsRouter from "../../src/api/routes/positions.js";
import { errorHandler } from "../../src/api/middleware/errorHandler.js";
import { testUtils } from "../setup.js";

describe("Integration Tests: GET /v1/positions/:wallet", () => {
  let app: FastifyInstance;
  let testWallet: string;

  beforeAll(async () => {
    // Create test server with real database
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(positionsRouter);
    
    // Generate test wallet address
    testWallet = testUtils.generateStellarAddress("GTEST");
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Wallet with data", () => {
    it("should return positions for wallet with data", async () => {
      // Create test market
      const market = await testUtils.createTestMarket({
        question: "Test market for positions",
      });

      // Create position for test wallet
      await testUtils.createTestPosition(market.id, testWallet, {
        yesShares: 150,
        noShares: 75,
        lockedCollateral: 2.25,
      });

      const response = await app.inject({
        method: "GET",
        url: `/positions/user/${testWallet}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      
      const position = body[0];
      expect(position.marketId).toBe(market.id);
      expect(position.userAddress).toBe(testWallet);
      expect(position.yesShares).toBe(150);
      expect(position.noShares).toBe(75);
      expect(position.lockedCollateral).toBe(2.25);
      expect(position.isSettled).toBe(false);
    });

    it("should calculate PnL fields and totals correctly", async () => {
      // Create test market
      const market = await testUtils.createTestMarket({
        question: "PnL calculation test",
      });

      // Create position with specific values for PnL calculation
      await testUtils.createTestPosition(market.id, testWallet, {
        yesShares: 200,
        noShares: 50,
        lockedCollateral: 3.75,
      });

      const response = await app.inject({
        method: "GET",
        url: `/positions/user/${testWallet}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      
      expect(body).toHaveLength(1);
      const position = body[0];
      
      // Verify calculated fields
      expect(position.potentialPayoutIfYes).toBe(200);
      expect(position.potentialPayoutIfNo).toBe(50);
      expect(position.netPosition).toBe(150); // 200 - 50
      
      // Verify market data is included
      expect(position.market).toBeDefined();
      expect(position.market.id).toBe(market.id);
      expect(position.market.question).toBe(market.question);
    });

    it("should handle multiple positions for same wallet", async () => {
      // Create multiple markets
      const market1 = await testUtils.createTestMarket({
        question: "First market",
      });
      const market2 = await testUtils.createTestMarket({
        question: "Second market",
      });

      // Create positions in both markets
      await testUtils.createTestPosition(market1.id, testWallet, {
        yesShares: 100,
        noShares: 0,
      });
      await testUtils.createTestPosition(market2.id, testWallet, {
        yesShares: 0,
        noShares: 100,
      });

      const response = await app.inject({
        method: "GET",
        url: `/positions/user/${testWallet}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      
      expect(body).toHaveLength(2);
      
      // Verify both positions are returned
      const positionIds = body.map((p: any) => p.marketId);
      expect(positionIds).toContain(market1.id);
      expect(positionIds).toContain(market2.id);
      
      // Verify calculations
      const pos1 = body.find((p: any) => p.marketId === market1.id);
      const pos2 = body.find((p: any) => p.marketId === market2.id);
      
      expect(pos1.netPosition).toBe(100);
      expect(pos2.netPosition).toBe(-100);
    });
  });

  describe("Wallet with no data", () => {
    it("should return empty array for wallet with no positions", async () => {
      const emptyWallet = testUtils.generateStellarAddress("GEMPTY");

      const response = await app.inject({
        method: "GET",
        url: `/positions/user/${emptyWallet}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(0);
    });
  });

  describe("Invalid wallet format", () => {
    it("should return 400 for invalid wallet format", async () => {
      const invalidAddresses = [
        "0xInvalidAddress",
        "invalid",
        "G" + "A".repeat(54), // Too short
        "G" + "A".repeat(56), // Too long
        "X" + "A".repeat(55), // Wrong prefix
        "",
        "GABC123!@#DEF", // Invalid characters
      ];

      for (const invalidAddress of invalidAddresses) {
        const response = await app.inject({
          method: "GET",
          url: `/positions/user/${invalidAddress}`,
        });

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.error).toContain("Invalid Stellar address");
      }
    });
  });

  describe("Fixed-precision assertions for numeric values", () => {
    it("should handle decimal precision correctly in calculations", async () => {
      const market = await testUtils.createTestMarket();

      // Create position with decimal collateral
      await testUtils.createTestPosition(market.id, testWallet, {
        yesShares: 123,
        noShares: 456,
        lockedCollateral: 1.23456789,
      });

      const response = await app.inject({
        method: "GET",
        url: `/positions/user/${testWallet}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      
      const position = body[0];
      
      // Verify precision is maintained
      expect(testUtils.assertDecimalEqual(position.lockedCollateral, 1.23456789)).toBe(true);
      expect(position.netPosition).toBe(-333); // 123 - 456
      
      // Test precision assertion utility
      expect(testUtils.assertDecimalEqual(0.12345678, 0.12345678)).toBe(true);
      expect(testUtils.assertDecimalEqual(0.12345678, 0.12345679)).toBe(false);
    });
  });

  describe("Edge cases", () => {
    it("should handle settled positions correctly", async () => {
      const market = await testUtils.createTestMarket();

      await testUtils.createTestPosition(market.id, testWallet, {
        yesShares: 100,
        noShares: 0,
        isSettled: true,
      });

      const response = await app.inject({
        method: "GET",
        url: `/positions/user/${testWallet}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      
      expect(body).toHaveLength(1);
      expect(body[0].isSettled).toBe(true);
      expect(body[0].netPosition).toBe(100);
    });

    it("should handle zero share positions", async () => {
      const market = await testUtils.createTestMarket();

      await testUtils.createTestPosition(market.id, testWallet, {
        yesShares: 0,
        noShares: 0,
        lockedCollateral: 0,
      });

      const response = await app.inject({
        method: "GET",
        url: `/positions/user/${testWallet}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      
      expect(body).toHaveLength(1);
      const position = body[0];
      expect(position.yesShares).toBe(0);
      expect(position.noShares).toBe(0);
      expect(position.lockedCollateral).toBe(0);
      expect(position.netPosition).toBe(0);
    });
  });
});
