import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { adminRoutes } from "../../src/api/routes/admin.js";
import { buildTestApp, resetRateLimits } from "./helpers/build-test-app.js";
import { testUtils } from "../setup.js";

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
});
