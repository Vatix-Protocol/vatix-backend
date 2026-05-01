import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { marketsRoutes } from "./markets.js";
import { errorHandler } from "../middleware/errorHandler.js";
import type { PrismaClient } from "../../generated/prisma/client";

const mockPrismaClient = {
  market: {
    findMany: vi.fn(),
  },
} as unknown as PrismaClient;

vi.mock("../../services/prisma.js", () => ({
  getPrismaClient: () => mockPrismaClient,
}));

describe("GET /markets", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(marketsRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("successful responses", () => {
    it("should return all markets when they exist", async () => {
      const mockMarkets = [
        {
          id: "market-1",
          question: "Will it rain tomorrow?",
          endTime: new Date("2026-02-01T00:00:00Z"),
          resolutionTime: null,
          oracleAddress: "GABC123...",
          status: "ACTIVE",
          outcome: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          id: "market-2",
          question: "Will the price go up?",
          endTime: new Date("2026-03-01T00:00:00Z"),
          resolutionTime: null,
          oracleAddress: "GDEF456...",
          status: "ACTIVE",
          outcome: null,
          createdAt: new Date("2026-01-02T00:00:00Z"),
          updatedAt: new Date("2026-01-02T00:00:00Z"),
        },
      ];

      (
        mockPrismaClient.market.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockMarkets);

      const response = await app.inject({
        method: "GET",
        url: "/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty("markets");
      expect(body).toHaveProperty("count");
      expect(body.markets).toHaveLength(2);
      expect(body.count).toBe(2);
      expect(body.markets[0].id).toBe("market-1");
      expect(body.markets[1].id).toBe("market-2");

      expect(mockPrismaClient.market.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { createdAt: "desc" },
      });
    });

    it("should return empty array when no markets exist", async () => {
      (
        mockPrismaClient.market.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);

      const response = await app.inject({
        method: "GET",
        url: "/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.markets).toEqual([]);
      expect(body.count).toBe(0);
    });
  });

  describe("status filter", () => {
    it("should filter markets by ACTIVE status", async () => {
      const mockActiveMarkets = [
        {
          id: "market-1",
          question: "Active market",
          endTime: new Date("2026-02-01T00:00:00Z"),
          resolutionTime: null,
          oracleAddress: "GABC123...",
          status: "ACTIVE",
          outcome: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ];

      (
        mockPrismaClient.market.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockActiveMarkets);

      const response = await app.inject({
        method: "GET",
        url: "/markets?status=ACTIVE",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.markets).toHaveLength(1);
      expect(body.markets[0].status).toBe("ACTIVE");

      expect(mockPrismaClient.market.findMany).toHaveBeenCalledWith({
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
      });
    });

    it("should filter markets by RESOLVED status", async () => {
      const mockResolvedMarkets = [
        {
          id: "market-2",
          question: "Resolved market",
          endTime: new Date("2026-01-15T00:00:00Z"),
          resolutionTime: new Date("2026-01-16T00:00:00Z"),
          oracleAddress: "GDEF456...",
          status: "RESOLVED",
          outcome: true,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-16T00:00:00Z"),
        },
      ];

      (
        mockPrismaClient.market.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockResolvedMarkets);

      const response = await app.inject({
        method: "GET",
        url: "/markets?status=RESOLVED",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.markets).toHaveLength(1);
      expect(body.markets[0].status).toBe("RESOLVED");

      expect(mockPrismaClient.market.findMany).toHaveBeenCalledWith({
        where: { status: "RESOLVED" },
        orderBy: { createdAt: "desc" },
      });
    });

    it("should filter markets by CANCELLED status", async () => {
      const mockCancelledMarkets = [
        {
          id: "market-3",
          question: "Cancelled market",
          endTime: new Date("2026-01-20T00:00:00Z"),
          resolutionTime: null,
          oracleAddress: "GHIJ789...",
          status: "CANCELLED",
          outcome: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-15T00:00:00Z"),
        },
      ];

      (
        mockPrismaClient.market.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockCancelledMarkets);

      const response = await app.inject({
        method: "GET",
        url: "/markets?status=CANCELLED",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.markets).toHaveLength(1);
      expect(body.markets[0].status).toBe("CANCELLED");

      expect(mockPrismaClient.market.findMany).toHaveBeenCalledWith({
        where: { status: "CANCELLED" },
        orderBy: { createdAt: "desc" },
      });
    });

    it("should reject invalid status values", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/markets?status=INVALID",
      });

      expect(response.statusCode).toBe(400);
    });

    it("should return empty array when no markets match filter", async () => {
      (
        mockPrismaClient.market.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);

      const response = await app.inject({
        method: "GET",
        url: "/markets?status=CANCELLED",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.markets).toEqual([]);
      expect(body.count).toBe(0);
    });
  });

  describe("error handling", () => {
    it("should return 500 when database error occurs", async () => {
      (
        mockPrismaClient.market.findMany as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("Database connection failed"));

      const response = await app.inject({
        method: "GET",
        url: "/markets",
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("statusCode", 500);
      expect(body).toHaveProperty("requestId");
    });

    it("should handle Prisma query timeout", async () => {
      (
        mockPrismaClient.market.findMany as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("Query timeout"));

      const response = await app.inject({
        method: "GET",
        url: "/markets",
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe("response format validation", () => {
    it("should return all market fields in correct format", async () => {
      const mockMarket = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        question: "Will Bitcoin reach $100k in 2026?",
        endTime: new Date("2026-12-31T23:59:59Z"),
        resolutionTime: null,
        oracleAddress:
          "GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA890",
        status: "ACTIVE",
        outcome: null,
        createdAt: new Date("2026-01-25T10:00:00Z"),
        updatedAt: new Date("2026-01-25T10:00:00Z"),
      };

      (
        mockPrismaClient.market.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([mockMarket]);

      const response = await app.inject({
        method: "GET",
        url: "/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.markets[0]).toMatchObject({
        id: mockMarket.id,
        question: mockMarket.question,
        endTime: mockMarket.endTime.toISOString(),
        resolutionTime: null,
        oracleAddress: mockMarket.oracleAddress,
        status: mockMarket.status,
        outcome: null,
        createdAt: mockMarket.createdAt.toISOString(),
        updatedAt: mockMarket.updatedAt.toISOString(),
      });
    });

    it("should handle resolved markets with outcome", async () => {
      const mockResolvedMarket = {
        id: "market-id",
        question: "Test question",
        endTime: new Date("2026-01-20T00:00:00Z"),
        resolutionTime: new Date("2026-01-21T00:00:00Z"),
        oracleAddress: "GABC123...",
        status: "RESOLVED",
        outcome: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-21T00:00:00Z"),
      };

      (
        mockPrismaClient.market.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([mockResolvedMarket]);

      const response = await app.inject({
        method: "GET",
        url: "/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.markets[0].outcome).toBe(true);
      expect(body.markets[0].resolutionTime).toBe(
        mockResolvedMarket.resolutionTime.toISOString()
      );
    });
  });

  describe("ordering", () => {
    it("should return markets ordered by createdAt descending (newest first)", async () => {
      const mockMarkets = [
        {
          id: "market-3",
          question: "Newest market",
          endTime: new Date("2026-02-01T00:00:00Z"),
          resolutionTime: null,
          oracleAddress: "GABC123...",
          status: "ACTIVE",
          outcome: null,
          createdAt: new Date("2026-01-25T00:00:00Z"),
          updatedAt: new Date("2026-01-25T00:00:00Z"),
        },
        {
          id: "market-2",
          question: "Middle market",
          endTime: new Date("2026-02-01T00:00:00Z"),
          resolutionTime: null,
          oracleAddress: "GDEF456...",
          status: "ACTIVE",
          outcome: null,
          createdAt: new Date("2026-01-20T00:00:00Z"),
          updatedAt: new Date("2026-01-20T00:00:00Z"),
        },
        {
          id: "market-1",
          question: "Oldest market",
          endTime: new Date("2026-02-01T00:00:00Z"),
          resolutionTime: null,
          oracleAddress: "GHIJ789...",
          status: "ACTIVE",
          outcome: null,
          createdAt: new Date("2026-01-15T00:00:00Z"),
          updatedAt: new Date("2026-01-15T00:00:00Z"),
        },
      ];

      (
        mockPrismaClient.market.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockMarkets);

      const response = await app.inject({
        method: "GET",
        url: "/markets",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.markets[0].id).toBe("market-3"); // Newest
      expect(body.markets[1].id).toBe("market-2"); // Middle
      expect(body.markets[2].id).toBe("market-1"); // Oldest
    });
  });
});
