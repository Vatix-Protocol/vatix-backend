import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { marketsRoutes } from "../../src/api/routes/markets.js";
import { errorHandler } from "../../src/api/middleware/errorHandler.js";
import { testUtils } from "../setup.js";

describe("Integration Tests: GET /v1/markets", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Create test server with real database
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(marketsRoutes);
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Default pagination and sort behavior", () => {
    it("should return markets sorted by creation date descending", async () => {
      // Create markets with different creation times
      const market1 = await testUtils.createTestMarket({
        question: "First market",
      });

      // Wait a bit to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      const market2 = await testUtils.createTestMarket({
        question: "Second market",
      });

      const response = await app.inject({
        method: "GET",
        url: "/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.markets).toHaveLength(2);
      expect(body.count).toBe(2);

      // Should be sorted by createdAt descending
      expect(body.markets[0].question).toBe("Second market");
      expect(body.markets[1].question).toBe("First market");

      // Verify response envelope structure
      expect(body).toHaveProperty("markets");
      expect(body).toHaveProperty("count");
      expect(Array.isArray(body.markets)).toBe(true);
      expect(typeof body.count).toBe("number");
    });

    it("should handle empty market list correctly", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.markets).toHaveLength(0);
      expect(body.count).toBe(0);
      expect(Array.isArray(body.markets)).toBe(true);
    });
  });

  describe("Status filtering", () => {
    it("should filter markets by status correctly", async () => {
      // Create markets with different statuses
      await testUtils.createTestMarket({
        question: "Active market",
        status: "ACTIVE",
      });

      await testUtils.createTestMarket({
        question: "Resolved market",
        status: "RESOLVED",
        outcome: true,
      });

      // Test ACTIVE filter
      const activeResponse = await app.inject({
        method: "GET",
        url: "/markets?status=ACTIVE",
      });

      expect(activeResponse.statusCode).toBe(200);
      const activeBody = JSON.parse(activeResponse.body);
      expect(activeBody.markets).toHaveLength(1);
      expect(activeBody.markets[0].status).toBe("ACTIVE");
      expect(activeBody.count).toBe(1);

      // Test RESOLVED filter
      const resolvedResponse = await app.inject({
        method: "GET",
        url: "/markets?status=RESOLVED",
      });

      expect(resolvedResponse.statusCode).toBe(200);
      const resolvedBody = JSON.parse(resolvedResponse.body);
      expect(resolvedBody.markets).toHaveLength(1);
      expect(resolvedBody.markets[0].status).toBe("RESOLVED");
      expect(resolvedBody.count).toBe(1);
    });

    it("should return empty list for non-existent status", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/markets?status=CANCELLED",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.markets).toHaveLength(0);
      expect(body.count).toBe(0);
    });
  });

  describe("Response envelope validation", () => {
    it("should return properly structured market objects", async () => {
      const market = await testUtils.createTestMarket({
        question: "Test market for structure validation",
        endTime: new Date("2026-12-31T23:59:59Z"),
        oracleAddress: testUtils.generateStellarAddress("GTEST"),
      });

      const response = await app.inject({
        method: "GET",
        url: "/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.markets).toHaveLength(1);
      const marketResponse = body.markets[0];

      // Verify all required fields are present and correctly typed
      expect(marketResponse).toHaveProperty("id");
      expect(marketResponse).toHaveProperty("question");
      expect(marketResponse).toHaveProperty("endTime");
      expect(marketResponse).toHaveProperty("resolutionTime");
      expect(marketResponse).toHaveProperty("oracleAddress");
      expect(marketResponse).toHaveProperty("status");
      expect(marketResponse).toHaveProperty("outcome");
      expect(marketResponse).toHaveProperty("createdAt");
      expect(marketResponse).toHaveProperty("updatedAt");

      // Verify field types
      expect(typeof marketResponse.id).toBe("string");
      expect(typeof marketResponse.question).toBe("string");
      expect(typeof marketResponse.endTime).toBe("string");
      expect(
        marketResponse.resolutionTime === null ||
          typeof marketResponse.resolutionTime === "string"
      ).toBe(true);
      expect(typeof marketResponse.oracleAddress).toBe("string");
      expect(typeof marketResponse.status).toBe("string");
      expect(
        marketResponse.outcome === null ||
          typeof marketResponse.outcome === "boolean"
      ).toBe(true);
      expect(typeof marketResponse.createdAt).toBe("string");
      expect(typeof marketResponse.updatedAt).toBe("string");

      // Verify values match
      expect(marketResponse.id).toBe(market.id);
      expect(marketResponse.question).toBe(market.question);
      expect(marketResponse.oracleAddress).toBe(market.oracleAddress);
      expect(marketResponse.status).toBe(market.status);
    });
  });

  describe("Edge cases", () => {
    it("should handle markets with null resolutionTime", async () => {
      await testUtils.createTestMarket({
        question: "Unresolved market",
        resolutionTime: null,
      });

      const response = await app.inject({
        method: "GET",
        url: "/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.markets).toHaveLength(1);
      expect(body.markets[0].resolutionTime).toBeNull();
    });

    it("should handle markets with resolutionTime", async () => {
      await testUtils.createTestMarket({
        question: "Resolved market",
        status: "RESOLVED",
        outcome: true,
        resolutionTime: new Date("2026-01-01T00:00:00Z"),
      });

      const response = await app.inject({
        method: "GET",
        url: "/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.markets).toHaveLength(1);
      expect(body.markets[0].resolutionTime).not.toBeNull();
      expect(typeof body.markets[0].resolutionTime).toBe("string");
    });
  });
});
