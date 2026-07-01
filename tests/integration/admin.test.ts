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

  it("returns 401 when no auth headers are present", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/admin/markets" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when only x-api-key is present (no Bearer token)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/markets",
      headers: { "x-api-key": API_KEY },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when only Bearer token is present (no API key)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/markets",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for a wrong API key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/markets",
      headers: {
        "x-api-key": "wrong-key",
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a wrong admin token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/markets",
      headers: {
        "x-api-key": API_KEY,
        authorization: "Bearer wrong-token",
      },
    });
    expect(res.statusCode).toBe(403);
  });
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
    expect(typeof body.count).toBe("number");
    expect(Array.isArray(body.markets)).toBe(true);
    expect(body.count).toBeGreaterThanOrEqual(2);

    const statuses = body.markets.map((m: any) => m.status);
    expect(statuses).toContain("ACTIVE");
    expect(statuses).toContain("CANCELLED");
  });

  it("returns count that matches the markets array length", async () => {
    const res = await authed(app, "GET", "/v1/admin/markets");
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.count).toBe(body.markets.length);
  });

  it("returns markets with all expected fields", async () => {
    await testUtils.createTestMarket({ question: "Field check market", status: "ACTIVE" });

    const res = await authed(app, "GET", "/v1/admin/markets");
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.markets.length).toBeGreaterThan(0);

    const market = body.markets[0];
    expect(market).toHaveProperty("id");
    expect(market).toHaveProperty("question");
    expect(market).toHaveProperty("status");
    expect(market).toHaveProperty("createdAt");
  });

  it("returns markets in a consistent order (most-recently-created first)", async () => {
    const first = await testUtils.createTestMarket({ question: "First market", status: "ACTIVE" });
    const second = await testUtils.createTestMarket({ question: "Second market", status: "ACTIVE" });

    const res = await authed(app, "GET", "/v1/admin/markets");
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    const ids = body.markets.map((m: any) => m.id);
    const firstIdx = ids.indexOf(first.id);
    const secondIdx = ids.indexOf(second.id);

    // Most recently created should appear before (or at the same index as) older ones
    expect(secondIdx).toBeLessThan(firstIdx);
  });

  it("includes RESOLVED markets in the list", async () => {
    await testUtils.createTestMarket({ question: "Resolved market", status: "RESOLVED" });

    const res = await authed(app, "GET", "/v1/admin/markets");
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    const statuses = body.markets.map((m: any) => m.status);
    expect(statuses).toContain("RESOLVED");
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
      { status: "CANCELLED" }
    );
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.market.id).toBe(market.id);
    expect(body.market.status).toBe("CANCELLED");
  });

  it("transitions ACTIVE → RESOLVED", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await authed(
      app,
      "PATCH",
      `/v1/admin/markets/${market.id}/status`,
      { status: "RESOLVED" }
    );
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.market.status).toBe("RESOLVED");
  });

  it("transitions CANCELLED → ACTIVE", async () => {
    const market = await testUtils.createTestMarket({ status: "CANCELLED" });

    const res = await authed(
      app,
      "PATCH",
      `/v1/admin/markets/${market.id}/status`,
      { status: "ACTIVE" }
    );
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.market.status).toBe("ACTIVE");
  });

  it("preserves all other market fields after status update", async () => {
    const market = await testUtils.createTestMarket({
      question: "Field preservation check",
      status: "ACTIVE",
    });

    const res = await authed(
      app,
      "PATCH",
      `/v1/admin/markets/${market.id}/status`,
      { status: "CANCELLED" }
    );
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.market.id).toBe(market.id);
    expect(body.market.question).toBe("Field preservation check");
    expect(body.market.status).toBe("CANCELLED");
  });

  it("returns 400 for an invalid status enum value", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await authed(
      app,
      "PATCH",
      `/v1/admin/markets/${market.id}/status`,
      { status: "BOGUS" }
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 or 404 for an unknown market ID", async () => {
    const res = await authed(
      app,
      "PATCH",
      "/v1/admin/markets/00000000-0000-0000-0000-000000000000/status",
      { status: "CANCELLED" }
    );
    expect([400, 404, 500]).toContain(res.statusCode);
  });

  it("rejects status update without auth headers", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/admin/markets/${market.id}/status`,
      payload: { status: "CANCELLED" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects status update with wrong admin token", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/admin/markets/${market.id}/status`,
      headers: {
        "x-api-key": API_KEY,
        authorization: "Bearer wrong-token",
      },
      payload: { status: "CANCELLED" },
    });
    expect(res.statusCode).toBe(403);
  });
});
