import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { marketsRoutes } from "./markets.js";
import { getPrismaClient } from "../../../../src/services/prisma.js";
import type { PrismaClient } from "../../../../src/generated/prisma/client.js";

vi.mock("../../../../src/services/prisma.js", () => ({
  getPrismaClient: vi.fn(),
}));

const mockPrisma = {
  market: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
  },
  indexedTrade: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
} as unknown as PrismaClient;

function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(marketsRoutes);
  return app;
}

/**
 * Install the mocked Prisma client for the duration of a test. The routes
 * resolve the client lazily per request, so this has to be (re-)installed in
 * `beforeEach` alongside `vi.clearAllMocks()`.
 */
function useMockPrisma(): void {
  vi.mocked(getPrismaClient).mockReturnValue(mockPrisma);
}

describe("GET /markets", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
    vi.clearAllMocks();
    useMockPrisma();
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
      }),
      expect.anything()
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
      }),
      expect.anything()
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
    useMockPrisma();
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
      }),
      expect.anything()
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
/**
 * Trade history pagination (#1143).
 *
 * The indexer appends to `indexed_trades` continuously, so the pagination
 * invariants that matter here are: a page never repeats or skips a row that
 * existed before the page was requested, a caller cannot force an unbounded
 * scan, and an unknown or soft-deleted market fails closed rather than
 * returning an indistinguishable empty list.
 */
describe("GET /markets/:id/trades", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
    vi.clearAllMocks();
    useMockPrisma();
    mockPrisma.market.findUnique.mockResolvedValue({ id: "market-1" });
  });

  afterEach(async () => {
    await app.close();
  });

  function trade(id: string) {
    return {
      id,
      marketId: "market-1",
      outcome: "YES",
      traderAddress: "GTRADER1",
      counterpartyAddress: "GTRADER2",
      direction: "BUY",
      priceRaw: "100000000",
      quantityRaw: "500000000",
      ledger: 100,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
  }

  it("returns 200 with a paginated trade list", async () => {
    mockPrisma.indexedTrade.findMany.mockResolvedValue([trade("t1")]);
    mockPrisma.indexedTrade.count.mockResolvedValue(1);

    const response = await app.inject({
      method: "GET",
      url: "/markets/market-1/trades",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.trades).toHaveLength(1);
    expect(body.items).toHaveLength(1);
    expect(body.count).toBe(1);
    expect(body.total).toBe(1);
    expect(body.nextCursor).toBeNull();
    expect(body).toHaveProperty("correlationId");
  });

  it("scopes the query to the requested market", async () => {
    mockPrisma.indexedTrade.findMany.mockResolvedValue([]);
    mockPrisma.indexedTrade.count.mockResolvedValue(0);

    await app.inject({ method: "GET", url: "/markets/market-1/trades" });

    expect(mockPrisma.indexedTrade.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ marketId: "market-1" }),
      }),
      expect.anything()
    );
  });

  it("resolves the cursor with a keyset range (id > cursor), not an offset", async () => {
    mockPrisma.indexedTrade.findMany.mockResolvedValue([]);
    mockPrisma.indexedTrade.count.mockResolvedValue(0);

    await app.inject({
      method: "GET",
      url: "/markets/market-1/trades?cursor=t5&limit=10",
    });

    const call = mockPrisma.indexedTrade.findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      marketId: "market-1",
      id: { gt: "t5" },
    });
    expect(call).not.toHaveProperty("skip");
    expect(call).not.toHaveProperty("cursor");
  });

  it("orders by the cursor column so paging is stable", async () => {
    mockPrisma.indexedTrade.findMany.mockResolvedValue([]);
    mockPrisma.indexedTrade.count.mockResolvedValue(0);

    await app.inject({ method: "GET", url: "/markets/market-1/trades" });

    expect(mockPrisma.indexedTrade.findMany.mock.calls[0][0].orderBy).toEqual({
      id: "asc",
    });
  });

  it("over-reads by one row to detect a next page and returns the last id as the cursor", async () => {
    mockPrisma.indexedTrade.findMany.mockResolvedValue([
      trade("t1"),
      trade("t2"),
      trade("t3"),
    ]);
    mockPrisma.indexedTrade.count.mockResolvedValue(9);

    const response = await app.inject({
      method: "GET",
      url: "/markets/market-1/trades?limit=2",
    });

    const body = JSON.parse(response.body);
    // take = limit + 1, but only `limit` rows are returned to the caller.
    expect(mockPrisma.indexedTrade.findMany.mock.calls[0][0].take).toBe(3);
    expect(body.trades).toHaveLength(2);
    expect(body.nextCursor).toBe("t2");
    // The cursor is the last *returned* id, so the next page starts at t3
    // with no gap and no duplicate.
    expect(body.trades.map((t: { id: string }) => t.id)).toEqual(["t1", "t2"]);
  });

  it("caps the page size so a caller cannot force an unbounded scan", async () => {
    mockPrisma.indexedTrade.findMany.mockResolvedValue([]);
    mockPrisma.indexedTrade.count.mockResolvedValue(0);

    const response = await app.inject({
      method: "GET",
      url: "/markets/market-1/trades?limit=100000",
    });

    expect(response.statusCode).toBe(400);
    expect(mockPrisma.indexedTrade.findMany).not.toHaveBeenCalled();
  });

  it("returns 400 for a limit below the minimum", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/markets/market-1/trades?limit=0",
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for a market that does not exist (fail-closed)", async () => {
    mockPrisma.market.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: "/markets/nonexistent/trades",
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe("TRADES_MARKET_NOT_FOUND");
    // No trade query is issued for an unknown market.
    expect(mockPrisma.indexedTrade.findMany).not.toHaveBeenCalled();
  });

  it("does not expose trades for a soft-deleted market", async () => {
    mockPrisma.market.findUnique.mockResolvedValue(null);

    await app.inject({ method: "GET", url: "/markets/deleted-market/trades" });

    // The lookup carries the soft-delete guard, so a deleted market resolves
    // to null and is reported as not found rather than leaking its history.
    expect(mockPrisma.market.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null }),
      }),
      expect.anything()
    );
  });

  it("returns 400 for an adversarial oversized market id", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/markets/${"A".repeat(65)}/trades`,
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe("MARKETS_VALIDATION_FAILED");
    // The rejected id is never echoed back into the response.
    expect(response.body).not.toContain("A".repeat(65));
  });

  it("returns 503 when the database is unavailable (fail-closed)", async () => {
    mockPrisma.indexedTrade.findMany.mockRejectedValue(new Error("DB down"));
    mockPrisma.indexedTrade.count.mockRejectedValue(new Error("DB down"));

    const response = await app.inject({
      method: "GET",
      url: "/markets/market-1/trades",
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.code).toBe("MARKETS_DEPENDENCY_UNAVAILABLE");
    expect(response.body).not.toContain("DB down");
  });

  it("echoes the correlation id from the request header", async () => {
    mockPrisma.indexedTrade.findMany.mockResolvedValue([]);
    mockPrisma.indexedTrade.count.mockResolvedValue(0);

    const response = await app.inject({
      method: "GET",
      url: "/markets/market-1/trades",
      headers: { "x-correlation-id": "corr-trades" },
    });

    expect(JSON.parse(response.body).correlationId).toBe("corr-trades");
  });
});
