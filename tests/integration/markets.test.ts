import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { marketsRoutes } from "../../src/api/routes/markets.js";
import { errorHandler } from "../../src/api/middleware/errorHandler.js";
import { testUtils, getTestPrismaClient } from "../setup.js";

describe("Integration Tests: GET /v1/markets", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Create test server with real database
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(marketsRoutes, { prefix: "/v1" });
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
        url: "/v1/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.data.markets).toHaveLength(2);
      expect(body.data.count).toBe(2);

      // Should be sorted by createdAt descending
      expect(body.data.markets[0].question).toBe("Second market");
      expect(body.data.markets[1].question).toBe("First market");

      // Verify response envelope structure
      expect(body).toHaveProperty("success");
      expect(body).toHaveProperty("data");
      expect(body.data).toHaveProperty("markets");
      expect(body.data).toHaveProperty("count");
      expect(Array.isArray(body.data.markets)).toBe(true);
      expect(typeof body.data.count).toBe("number");
    });

    it("should handle empty market list correctly", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.data.markets).toHaveLength(0);
      expect(body.data.count).toBe(0);
      expect(Array.isArray(body.data.markets)).toBe(true);
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
        url: "/v1/markets?status=ACTIVE",
      });

      expect(activeResponse.statusCode).toBe(200);
      const activeBody = JSON.parse(activeResponse.body);
      expect(activeBody.data.markets).toHaveLength(1);
      expect(activeBody.data.markets[0].status).toBe("ACTIVE");
      expect(activeBody.data.count).toBe(1);

      // Test RESOLVED filter
      const resolvedResponse = await app.inject({
        method: "GET",
        url: "/v1/markets?status=RESOLVED",
      });

      expect(resolvedResponse.statusCode).toBe(200);
      const resolvedBody = JSON.parse(resolvedResponse.body);
      expect(resolvedBody.data.markets).toHaveLength(1);
      expect(resolvedBody.data.markets[0].status).toBe("RESOLVED");
      expect(resolvedBody.data.count).toBe(1);
    });

    it("should return empty list for non-existent status", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/markets?status=CANCELLED",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.markets).toHaveLength(0);
      expect(body.data.count).toBe(0);
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
        url: "/v1/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.data.markets).toHaveLength(1);
      const marketResponse = body.data.markets[0];

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

  describe("Input validation", () => {
    it("should return 400 for invalid status value", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/markets?status=INVALID",
      });

      expect(response.statusCode).toBe(400);
    });

    it("should return 400 for limit below minimum", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/markets?limit=0",
      });

      expect(response.statusCode).toBe(400);
    });

    it("should return 400 for limit above maximum", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/markets?limit=101",
      });

      expect(response.statusCode).toBe(400);
    });

    it("should ignore unknown query parameters", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/markets?unknown=value",
      });

      // Unknown parameters are silently ignored
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty("success");
      expect(body).toHaveProperty("data");
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
        url: "/v1/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.markets).toHaveLength(1);
      expect(body.data.markets[0].resolutionTime).toBeNull();
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
        url: "/v1/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.markets).toHaveLength(1);
      expect(body.data.markets[0].resolutionTime).not.toBeNull();
      expect(typeof body.data.markets[0].resolutionTime).toBe("string");
    });
  });
});

/**
 * Market search + soft-delete integration coverage (#1145). The mocked-Prisma
 * unit tests pin the predicate; these pin the observable behaviour against a
 * real database (soft-deleted rows exist but must never be returned).
 */
describe("Integration Tests: GET /v1/markets search (#1145)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(marketsRoutes, { prefix: "/v1" });
  });

  afterAll(async () => {
    await app.close();
  });

  it("excludes soft-deleted markets from search results", async () => {
    const prisma = getTestPrismaClient();

    const visible = await testUtils.createTestMarket({
      question: "Will it rain in Lisbon tomorrow?",
    });
    const deleted = await testUtils.createTestMarket({
      question: "Will it rain in Lisbon forever?",
    });
    await prisma.market.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/markets?q=lisbon",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.markets.map((m: { id: string }) => m.id)).toEqual([
      visible.id,
    ]);
    expect(body.data.count).toBe(1);
  });

  it("matches case-insensitively on a question substring", async () => {
    await testUtils.createTestMarket({ question: "Will BITCOIN hit 200k?" });
    await testUtils.createTestMarket({ question: "Will Ethereum merge?" });

    const response = await app.inject({
      method: "GET",
      url: "/v1/markets?q=bitcoin",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.markets).toHaveLength(1);
    expect(body.data.markets[0].question).toContain("BITCOIN");
  });

  it("rejects an out-of-range search term before touching the database", async () => {
    const tooShort = await app.inject({
      method: "GET",
      url: "/v1/markets?q=a",
    });
    const tooLong = await app.inject({
      method: "GET",
      url: `/v1/markets?q=${"a".repeat(201)}`,
    });

    expect(tooShort.statusCode).toBe(400);
    expect(tooLong.statusCode).toBe(400);
  });
});
