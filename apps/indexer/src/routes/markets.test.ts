import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { marketsRoutes } from "./markets.js";
import { getPrismaClient } from "../../../../src/services/prisma.js";
import type { PrismaClient } from "../../../../src/generated/prisma/client.js";

vi.mock("../../../../src/services/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
}));

const mockPrisma = {
  market: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
  },
} as unknown as PrismaClient;

function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(marketsRoutes);
  return app;
}

describe("GET /markets", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 200 with an array of markets", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      {
        id: "market-1",
        question: "Will it rain?",
        endTime: new Date("2026-06-01T00:00:00Z"),
        oracleAddress: "GABC...",
        status: "ACTIVE",
        outcome: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    mockPrisma.market.count.mockResolvedValue(1);

    const response = await app.inject({
      method: "GET",
      url: "/markets",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.markets).toBeInstanceOf(Array);
    expect(body.markets).toHaveLength(1);
    expect(body.markets[0].id).toBe("market-1");
    expect(body.count).toBe(1);
    expect(body.total).toBe(1);
    expect(body.nextCursor).toBeNull();
    expect(body).toHaveProperty("correlationId");
  });

  it("filters by status when provided", async () => {
    mockPrisma.market.findMany.mockResolvedValue([]);
    mockPrisma.market.count.mockResolvedValue(0);

    await app.inject({
      method: "GET",
      url: "/markets?status=ACTIVE",
    });

    expect(mockPrisma.market.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "ACTIVE" }),
      })
    );
  });

  it("applies cursor pagination when provided", async () => {
    mockPrisma.market.findMany.mockResolvedValue([]);
    mockPrisma.market.count.mockResolvedValue(0);

    await app.inject({
      method: "GET",
      url: "/markets?cursor=market-1&limit=10",
    });

    expect(mockPrisma.market.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { gt: "market-1" },
        }),
      })
    );
  });

  it("returns 400 for an invalid status query parameter", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/markets?status=INVALID",
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for a limit exceeding the maximum", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/markets?limit=101",
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 503 when the database is unavailable", async () => {
    mockPrisma.market.findMany.mockRejectedValue(new Error("DB down"));

    const response = await app.inject({
      method: "GET",
      url: "/markets",
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.code).toBe("MARKETS_DEPENDENCY_UNAVAILABLE");
    expect(body).toHaveProperty("correlationId");
  });

  it("includes correlation id from x-correlation-id header", async () => {
    mockPrisma.market.findMany.mockResolvedValue([]);
    mockPrisma.market.count.mockResolvedValue(0);

    const response = await app.inject({
      method: "GET",
      url: "/markets",
      headers: { "x-correlation-id": "corr-123" },
    });

    const body = JSON.parse(response.body);
    expect(body.correlationId).toBe("corr-123");
  });
});

describe("GET /markets/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 200 with a single market", async () => {
    mockPrisma.market.findUnique.mockResolvedValue({
      id: "market-1",
      question: "Will it rain?",
      endTime: new Date("2026-06-01T00:00:00Z"),
      oracleAddress: "GABC...",
      status: "ACTIVE",
      outcome: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const response = await app.inject({
      method: "GET",
      url: "/markets/market-1",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.market.id).toBe("market-1");
    expect(body).toHaveProperty("correlationId");
  });

  it("returns 404 when the market does not exist", async () => {
    mockPrisma.market.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: "/markets/nonexistent",
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe("MARKETS_NOT_FOUND");
    expect(body).toHaveProperty("correlationId");
  });

  it("excludes soft-deleted markets", async () => {
    mockPrisma.market.findUnique.mockResolvedValue(null);

    await app.inject({
      method: "GET",
      url: "/markets/market-1",
    });

    expect(mockPrisma.market.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
        }),
      })
    );
  });

  it("returns 503 when the database is unavailable", async () => {
    mockPrisma.market.findUnique.mockRejectedValue(new Error("DB down"));

    const response = await app.inject({
      method: "GET",
      url: "/markets/market-1",
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.code).toBe("MARKETS_DEPENDENCY_UNAVAILABLE");
    expect(body).toHaveProperty("correlationId");
  });

  it("includes correlation id from x-correlation-id header", async () => {
    mockPrisma.market.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: "/markets/nonexistent",
      headers: { "x-correlation-id": "corr-456" },
    });

    const body = JSON.parse(response.body);
    expect(body.correlationId).toBe("corr-456");
  });
});
