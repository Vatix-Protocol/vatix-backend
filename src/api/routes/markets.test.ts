import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { marketsRoutes } from "./markets.js";
import { errorHandler } from "../middleware/errorHandler.js";
import type { PrismaClient } from "../../generated/prisma/client";

const mockPrismaClient = {
  market: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  order: {
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
      expect(body).toHaveProperty("data");
      expect(body.data).toHaveProperty("markets");
      expect(body.data).toHaveProperty("count");
      expect(body.data.markets).toHaveLength(2);
      expect(body.data.count).toBe(2);
      expect(body.data.markets[0].id).toBe("market-1");
      expect(body.data.markets[1].id).toBe("market-2");

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
      expect(body.data.markets).toEqual([]);
      expect(body.data.count).toBe(0);
    });
  });

  describe("market detail endpoint", () => {
    it("should return a single market by id", async () => {
      const mockMarket = {
        id: "market-1",
        question: "Will it rain tomorrow?",
        endTime: new Date("2026-02-01T00:00:00Z"),
        resolutionTime: null,
        oracleAddress: "GABC123...",
        status: "ACTIVE",
        outcome: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      };

      (
        mockPrismaClient.market.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockMarket);

      const response = await app.inject({
        method: "GET",
        url: "/markets/market-1",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.market).toMatchObject({
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

    it("should return 404 when market id is unknown", async () => {
      (
        mockPrismaClient.market.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(null);

      const response = await app.inject({
        method: "GET",
        url: "/markets/unknown-id",
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("statusCode", 404);
    });
  });

  describe("market orderbook endpoint", () => {
    it("should return a bid/ask snapshot for a market", async () => {
      const mockMarket = {
        id: "market-1",
        question: "Will it rain tomorrow?",
        endTime: new Date("2026-02-01T00:00:00Z"),
        resolutionTime: null,
        oracleAddress: "GABC123...",
        status: "ACTIVE",
        outcome: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      };
      const mockOrders = [
        {
          side: "BUY",
          outcome: "YES",
          price: "0.45",
          quantity: 100,
          filledQuantity: 25,
        },
        {
          side: "SELL",
          outcome: "YES",
          price: "0.55",
          quantity: 50,
          filledQuantity: 0,
        },
        {
          side: "BUY",
          outcome: "NO",
          price: "0.35",
          quantity: 30,
          filledQuantity: 10,
        },
      ];

      (
        mockPrismaClient.market.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockMarket);
      (
        mockPrismaClient.order.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockOrders);

      const response = await app.inject({
        method: "GET",
        url: "/markets/market-1/orderbook",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.orderbook.marketId).toBe("market-1");
      expect(body.data.orderbook.bids).toHaveLength(2);
      expect(body.data.orderbook.asks).toHaveLength(1);
      expect(body.data.orderbook.ledgerSequence).toBeNull();
      expect(typeof body.data.orderbook.snapshotTimestamp).toBe("string");
      expect(body.data.orderbook.bids[0].price).toBeGreaterThanOrEqual(
        body.data.orderbook.bids[1].price
      );
    });

    it("should return empty bids and asks when no open orders exist", async () => {
      const mockMarket = {
        id: "market-1",
        question: "Will it rain tomorrow?",
        endTime: new Date("2026-02-01T00:00:00Z"),
        resolutionTime: null,
        oracleAddress: "GABC123...",
        status: "ACTIVE",
        outcome: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      };

      (
        mockPrismaClient.market.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockMarket);
      (
        mockPrismaClient.order.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);

      const response = await app.inject({
        method: "GET",
        url: "/markets/market-1/orderbook",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.orderbook.bids).toEqual([]);
      expect(body.data.orderbook.asks).toEqual([]);
      expect(body.data.orderbook.ledgerSequence).toBeNull();
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
      expect(body.data.markets).toHaveLength(1);
      expect(body.data.markets[0].status).toBe("ACTIVE");

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
      expect(body.data.markets).toHaveLength(1);
      expect(body.data.markets[0].status).toBe("RESOLVED");

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
      expect(body.data.markets).toHaveLength(1);
      expect(body.data.markets[0].status).toBe("CANCELLED");

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
      expect(body.data.markets).toEqual([]);
      expect(body.data.count).toBe(0);
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

      expect(body.data.markets[0]).toMatchObject({
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
      expect(body.data.markets[0].outcome).toBe(true);
      expect(body.data.markets[0].resolutionTime).toBe(
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
      expect(body.data.markets[0].id).toBe("market-3"); // Newest
      expect(body.data.markets[1].id).toBe("market-2"); // Middle
      expect(body.data.markets[2].id).toBe("market-1"); // Oldest
    });
  });
});
