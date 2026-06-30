import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { marketsRoutes } from "../src/api/routes/markets.js";
import { errorHandler } from "../src/api/middleware/errorHandler.js";
import type { PrismaClient } from "../src/generated/prisma/client";

const mockPrisma = {
  market: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  order: {
    findMany: vi.fn(),
  },
} as unknown as PrismaClient;

vi.mock("../src/services/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
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

  it("returns 200 with markets array and count", async () => {
    const mockMarkets = [
      {
        id: "market-1",
        question: "Will it rain?",
        endTime: new Date("2026-06-01T00:00:00Z"),
        resolutionTime: null,
        oracleAddress: "GABC123...",
        status: "ACTIVE",
        outcome: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];

    (mockPrisma.market.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockMarkets
    );

    const response = await app.inject({ method: "GET", url: "/markets" });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.markets).toHaveLength(1);
    expect(body.data.count).toBe(1);
    expect(body.data.markets[0].id).toBe("market-1");
  });

  it("returns empty array when no markets exist", async () => {
    (mockPrisma.market.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      []
    );

    const response = await app.inject({ method: "GET", url: "/markets" });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.markets).toEqual([]);
    expect(body.data.count).toBe(0);
  });

  it("filters by status query param", async () => {
    (mockPrisma.market.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      []
    );

    await app.inject({ method: "GET", url: "/markets?status=ACTIVE" });

    expect(mockPrisma.market.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "ACTIVE" } })
    );
  });

  it("rejects invalid status with 400", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/markets?status=INVALID",
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 500 on database error", async () => {
    (mockPrisma.market.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("DB error")
    );

    const response = await app.inject({ method: "GET", url: "/markets" });
    expect(response.statusCode).toBe(500);
  });
});

describe("GET /markets/:id", () => {
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

  it("returns market when found", async () => {
    const mockMarket = {
      id: "market-1",
      question: "Will it rain?",
      endTime: new Date("2026-06-01T00:00:00Z"),
      resolutionTime: null,
      oracleAddress: "GABC123...",
      status: "ACTIVE",
      outcome: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };

    (
      mockPrisma.market.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue(mockMarket);

    const response = await app.inject({
      method: "GET",
      url: "/markets/market-1",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.market.id).toBe("market-1");
  });

  it("returns 404 when market not found", async () => {
    (
      mockPrisma.market.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: "/markets/unknown",
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe("market_not_found");
  });
});
