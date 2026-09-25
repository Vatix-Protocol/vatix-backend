import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { adminRoutes } from "../../src/api/routes/admin.js";
import { computeMarketEtag } from "../../src/api/routes/market.dto.js";
import { buildTestApp, resetRateLimits } from "./helpers/build-test-app.js";
import { testUtils, getTestPrismaClient } from "../setup.js";

const API_KEY = "test-api-key";
const ADMIN_TOKEN = "test-admin-token";

/** Inject with both auth headers (happy path). */
function authed(
  app: FastifyInstance,
  method: "GET" | "PATCH",
  url: string,
  payload?: object
) {
  return app.inject({
    method,
    url,
    headers: {
      "x-api-key": API_KEY,
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    ...(payload ? { payload } : {}),
  });
}

describe("Admin routes — auth guard matrix", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.API_KEY = API_KEY;
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    app = await buildTestApp({ plugins: [adminRoutes] });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetRateLimits();
  });

  const guardedEndpoints: Array<{
    method: "GET" | "PATCH";
    url: string;
    payload?: object;
  }> = [
    { method: "GET", url: "/v1/admin/markets" },
    {
      method: "PATCH",
      url: "/v1/admin/markets/00000000-0000-0000-0000-000000000000/status",
      payload: { status: "CANCELLED" },
    },
    { method: "GET", url: "/v1/admin/analytics/summary" },
  ];

  it.each(guardedEndpoints)(
    "returns 401 when no auth headers are present ($method $url)",
    async ({ method, url, payload }) => {
      const res = await app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(401);
    }
  );

  it.each(guardedEndpoints)(
    "returns 401 when only x-api-key is present ($method $url)",
    async ({ method, url, payload }) => {
      const res = await app.inject({
        method,
        url,
        headers: { "x-api-key": API_KEY },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(401);
    }
  );

  it.each(guardedEndpoints)(
    "returns 401 when only Bearer token is present ($method $url)",
    async ({ method, url, payload }) => {
      const res = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(401);
    }
  );

  it.each(guardedEndpoints)(
    "returns 401 for a wrong API key ($method $url)",
    async ({ method, url, payload }) => {
      const res = await app.inject({
        method,
        url,
        headers: {
          "x-api-key": "wrong-key",
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(401);
    }
  );

  it.each(guardedEndpoints)(
    "returns 403 for a wrong admin token ($method $url)",
    async ({ method, url, payload }) => {
      const res = await app.inject({
        method,
        url,
        headers: { "x-api-key": API_KEY, authorization: "Bearer wrong-token" },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(403);
    }
  );
});

describe("GET /v1/admin/markets", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.API_KEY = API_KEY;
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    app = await buildTestApp({ plugins: [adminRoutes] });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetRateLimits();
  });

  it("returns 200 with all markets including CANCELLED ones", async () => {
    await testUtils.createTestMarket({
      question: "Active market",
      status: "ACTIVE",
    });
    await testUtils.createTestMarket({
      question: "Cancelled market",
      status: "CANCELLED",
    });

    const res = await authed(app, "GET", "/v1/admin/markets");
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(typeof body.data.count).toBe("number");
    expect(Array.isArray(body.data.markets)).toBe(true);
    expect(body.data.count).toBeGreaterThanOrEqual(2);

    const statuses = body.data.markets.map((m: any) => m.status);
    expect(statuses).toContain("ACTIVE");
    expect(statuses).toContain("CANCELLED");
  });
});

describe("GET /v1/admin/analytics/summary (#743)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.API_KEY = API_KEY;
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    app = await buildTestApp({ plugins: [adminRoutes] });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetRateLimits();
  });

  it("returns 200 with an aggregate market/trade summary", async () => {
    await testUtils.createTestMarket({
      question: "Active market",
      status: "ACTIVE",
    });
    await testUtils.createTestMarket({
      question: "Cancelled market",
      status: "CANCELLED",
    });

    const res = await authed(app, "GET", "/v1/admin/analytics/summary");
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.marketsByStatus.ACTIVE).toBeGreaterThanOrEqual(1);
    expect(body.data.marketsByStatus.CANCELLED).toBeGreaterThanOrEqual(1);
    expect(typeof body.data.totalTrades).toBe("number");
    expect(typeof body.data.totalTradedQuantity).toBe("number");
  });

  it('reports source: "primary" when ANALYTICS_DATABASE_URL is unset', async () => {
    expect(process.env.ANALYTICS_DATABASE_URL).toBeUndefined();

    const res = await authed(app, "GET", "/v1/admin/analytics/summary");
    const body = JSON.parse(res.body);
    expect(body.data.source).toBe("primary");
  });
});

describe("PATCH /v1/admin/markets/:id/status", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.API_KEY = API_KEY;
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    app = await buildTestApp({ plugins: [adminRoutes] });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetRateLimits();
  });

  it("updates market status in Postgres and returns 200", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await authed(
      app,
      "PATCH",
      `/v1/admin/markets/${market.id}/status`,
      {
        status: "CANCELLED",
      }
    );
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.market.id).toBe(market.id);
    expect(body.data.market.status).toBe("CANCELLED");
  });

  it("returns 409 for a transition the lifecycle matrix forbids", async () => {
    const market = await testUtils.createTestMarket({ status: "RESOLVED" });

    const res = await authed(
      app,
      "PATCH",
      `/v1/admin/markets/${market.id}/status`,
      {
        status: "ACTIVE",
      }
    );
    expect(res.statusCode).toBe(409);

    const body = JSON.parse(res.body);
    expect(body.code).toBe("market_invalid_transition");

    const persisted = await getTestPrismaClient().market.findUnique({
      where: { id: market.id },
    });
    expect(persisted?.status).toBe("RESOLVED");
  });

  it("returns 400 for an invalid status enum value", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await authed(
      app,
      "PATCH",
      `/v1/admin/markets/${market.id}/status`,
      {
        status: "BOGUS",
      }
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown market ID", async () => {
    const res = await authed(
      app,
      "PATCH",
      "/v1/admin/markets/00000000-0000-0000-0000-000000000000/status",
      { status: "CANCELLED" }
    );
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("market_not_found");
  });

  it("sets an ETag response header on a successful update", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await authed(
      app,
      "PATCH",
      `/v1/admin/markets/${market.id}/status`,
      { status: "CANCELLED" }
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBeDefined();
  });

  it("applies the update when If-Match matches the market's current ETag", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const etag = computeMarketEtag(market);

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/admin/markets/${market.id}/status`,
      headers: {
        "x-api-key": API_KEY,
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "if-match": etag,
      },
      payload: { status: "CANCELLED" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.market.status).toBe("CANCELLED");
  });

  it("rejects the update with 412 when If-Match is stale", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // Update once so the market's ETag (derived from updatedAt) moves on.
    await authed(app, "PATCH", `/v1/admin/markets/${market.id}/status`, {
      status: "RESOLVED",
    });

    const staleEtag = `W/"${market.id}-1"`;
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/admin/markets/${market.id}/status`,
      headers: {
        "x-api-key": API_KEY,
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "if-match": staleEtag,
      },
      payload: { status: "CANCELLED" },
    });

    expect(res.statusCode).toBe(412);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("precondition_failed");
  });

  it("allows If-Match: * to pass through regardless of current state", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/admin/markets/${market.id}/status`,
      headers: {
        "x-api-key": API_KEY,
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "if-match": "*",
      },
      payload: { status: "CANCELLED" },
    });

    expect(res.statusCode).toBe(200);
  });
});

describe("Admin routes — position reconciliation", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.API_KEY = API_KEY;
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    app = await buildTestApp({ plugins: [adminRoutes] });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetRateLimits();
  });

  it("POST /admin/markets/:id/reconcile requires admin auth", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/markets/${market.id}/reconcile`,
      headers: {
        "x-api-key": "wrong-key",
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it("POST /admin/markets/:id/reconcile returns 404 for unknown market", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/markets/00000000-0000-0000-0000-000000000000/reconcile",
      headers: {
        "x-api-key": API_KEY,
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("market_not_found");
  });

  it("POST /admin/markets/:id/reconcile runs reconciliation and returns stats", async () => {
    const prisma = getTestPrismaClient();
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const wallet = "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTICSWY7YQJGOUHKS2DTWRWOE";

    // Create a position with no matching events (simulates drift)
    await prisma.userPosition.create({
      data: {
        marketId: market.id,
        userAddress: wallet,
        yesShares: 100,
        noShares: 0,
        lockedCollateral: { set: "50" },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/markets/${market.id}/reconcile`,
      headers: {
        "x-api-key": API_KEY,
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveProperty("reconciliation");
    expect(body.data.reconciliation).toHaveProperty("marketId", market.id);
    expect(body.data.reconciliation).toHaveProperty("totalWallets");
    expect(body.data.reconciliation).toHaveProperty("driftCount");
    expect(body.data.reconciliation).toHaveProperty("recoveredCount");
    expect(body.data).toHaveProperty("triggeredBy");
    expect(body.data).toHaveProperty("timestamp");
  });

  it("POST /admin/markets/:id/reconcile detects and fixes drift", async () => {
    const prisma = getTestPrismaClient();
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const wallet = "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTICSWY7YQJGOUHKS2DTWRWOE";

    // Simulate drift: position exists but no matching events
    await prisma.userPosition.create({
      data: {
        marketId: market.id,
        userAddress: wallet,
        yesShares: 50,
        noShares: 25,
        lockedCollateral: { set: "100" },
      },
    });

    // Before reconciliation, position is drifted
    const beforeReconcile = await prisma.userPosition.findUnique({
      where: {
        marketId_userAddress: { marketId: market.id, userAddress: wallet },
      },
    });
    expect(beforeReconcile?.yesShares).toBe(50);

    // Reconcile (should auto-recover and zero out the position since no events exist)
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/markets/${market.id}/reconcile`,
      headers: {
        "x-api-key": API_KEY,
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.reconciliation.driftCount).toBeGreaterThan(0);
    expect(body.data.reconciliation.recoveredCount).toBeGreaterThan(0);

    // After reconciliation, position should be updated (zero shares since no events)
    const afterReconcile = await prisma.userPosition.findUnique({
      where: {
        marketId_userAddress: { marketId: market.id, userAddress: wallet },
      },
    });
    expect(afterReconcile?.yesShares).toBe(0);
    expect(afterReconcile?.noShares).toBe(0);
  });
});
