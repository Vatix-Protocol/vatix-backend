import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const mockMarket = {
  updateMany: vi.fn(),
  findUnique: vi.fn(),
};

vi.mock("../db", () => ({
  db: {
    market: mockMarket,
  },
}));

vi.mock("../middleware/requireAdmin", () => ({
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = { id: "admin-1", role: "ADMIN" };
  },
}));

import { marketsRoutes } from "./markets.js";

function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(marketsRoutes);
  return app;
}

describe("POST /admin/markets/:id/restore", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it("restores a soft-deleted market and returns 200 with restored: true", async () => {
    mockMarket.updateMany.mockResolvedValue({ count: 1 });

    const response = await app.inject({
      method: "POST",
      url: "/admin/markets/market-1/restore",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.restored).toBe(true);
    expect(body.correlationId).toBeTruthy();
    expect(mockMarket.updateMany).toHaveBeenCalledTimes(1);
    expect(mockMarket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "market-1",
          deletedAt: { not: null },
          hardDeletedAt: null,
        }),
      }),
    );
  });

  it("treats a replay of an already-active market as idempotent (200, restored: false)", async () => {
    mockMarket.updateMany.mockResolvedValue({ count: 0 });
    mockMarket.findUnique.mockResolvedValue({
      id: "market-1",
      deletedAt: null,
      hardDeletedAt: null,
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/markets/market-1/restore",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.restored).toBe(false);
    expect(body.correlationId).toBeTruthy();
    expect(mockMarket.updateMany).toHaveBeenCalledTimes(1);
  });

  it("returns 404 MARKET_NOT_FOUND when the market does not exist", async () => {
    mockMarket.updateMany.mockResolvedValue({ count: 0 });
    mockMarket.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: "/admin/markets/unknown/restore",
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("MARKET_NOT_FOUND");
    expect(body.correlationId).toBeTruthy();
  });

  it("returns 404 MARKET_NOT_FOUND when the market is hard-deleted", async () => {
    mockMarket.updateMany.mockResolvedValue({ count: 0 });
    mockMarket.findUnique.mockResolvedValue({
      id: "market-1",
      deletedAt: new Date("2026-01-01T00:00:00Z"),
      hardDeletedAt: new Date("2026-02-01T00:00:00Z"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/markets/market-1/restore",
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("MARKET_NOT_FOUND");
    expect(body.correlationId).toBeTruthy();
  });

  it("returns 503 MARKET_DEPENDENCY_UNAVAILABLE when the write fails", async () => {
    mockMarket.updateMany.mockRejectedValue(new Error("DB down"));

    const response = await app.inject({
      method: "POST",
      url: "/admin/markets/market-1/restore",
    });

    expect(response.statusCode).toBe(503);
    expect(response.statusCode).not.toBe(200);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("MARKET_DEPENDENCY_UNAVAILABLE");
    expect(body.correlationId).toBeTruthy();
  });
});
