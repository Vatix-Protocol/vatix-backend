import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/index.js";
import { testUtils } from "../setup.js";
import { openApiSpec } from "../../src/api/openapi.js";

// Mock the prisma service
vi.mock("../../src/services/prisma.js", () => {
  return {
    getPrismaClient: () => ({
      $queryRaw: async () => {},
      indexerCursor: {
        findFirst: async () => ({
          networkId: "testnet",
          cursorKey: "ingestion",
          cursorValue: "123456",
          updatedAt: new Date(),
        }),
      },
      market: {
        findMany: async () => [],
        findUnique: async () => ({
          id: "api-versioning-market-id",
          question: "API versioning market",
          endTime: new Date(),
          oracleAddress: "G" + "A".repeat(55),
          status: "ACTIVE",
          outcome: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      order: {
        groupBy: async () => [],
        findMany: async () => [],
      },
      userPosition: {
        findMany: async () => [],
      },
    }),
  };
});

const wallet = testUtils.generateStellarAddress("GUSER");

describe("Integration Tests: API versioning", () => {
  let app: FastifyInstance;
  let marketId: string;

  beforeAll(async () => {
    vi.spyOn(testUtils, "createTestMarket").mockResolvedValue({
      id: "api-versioning-market-id",
    } as any);

    app = buildServer({
      logger: false,
      registerTestRoutes: false,
      readyDeps: {
        checkDatabase: async () => {},
        getLastIndexedAt: async () => Date.now(),
      },
    });

    await app.ready();
  });

  beforeEach(async () => {
    const market = await testUtils.createTestMarket({
      question: "API versioning market",
      status: "ACTIVE",
    });
    marketId = market.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves public routes under /v1", async () => {
    const requests = [
      { method: "GET", url: "/v1/health", expected: 200 },
      { method: "GET", url: "/v1/ready", expected: 200 },
      { method: "GET", url: "/v1/markets", expected: 200 },
      { method: "GET", url: `/v1/markets/${marketId}`, expected: 200 },
      {
        method: "GET",
        url: `/v1/markets/${marketId}/orderbook`,
        expected: 200,
      },
      { method: "GET", url: `/v1/orders/user/${wallet}`, expected: 200 },
      { method: "GET", url: `/v1/trades/user/${wallet}`, expected: 200 },
      {
        method: "GET",
        url: `/v1/wallets/${wallet}/positions`,
        expected: 200,
      },
      { method: "GET", url: "/v1/openapi.json", expected: 200 },
    ] as const;

    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(
        request.expected
      );
    }
  });

  it("keeps admin routes registered under /v1 behind auth", async () => {
    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/admin/markets",
    });
    const patchResponse = await app.inject({
      method: "PATCH",
      url: `/v1/admin/markets/${marketId}/status`,
      payload: { status: "CANCELLED" },
    });

    expect(listResponse.statusCode).toBe(401);
    expect(patchResponse.statusCode).toBe(401);
  });

  it("redirects legacy aliases with deprecation headers", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/positions/user/${wallet}?marketId=${marketId}`,
    });

    expect(response.statusCode).toBe(308);
    expect(response.headers.location).toBe(
      `/v1/wallets/${wallet}/positions?marketId=${marketId}`
    );
    expect(response.headers.deprecation).toBe("true");
    expect(response.headers.sunset).toBe("2026-09-27T00:00:00Z");
    expect(response.headers.link).toBe(
      `</v1/wallets/${wallet}/positions?marketId=${marketId}>; rel="alternate"`
    );
  });

  it("returns 404 for root paths that are not compatibility aliases", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/not-a-public-route",
    });

    expect(response.statusCode).toBe(404);
  });

  it("mounts OpenAPI at /v1/openapi.json with only /v1 path keys", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openapi.json",
    });

    expect(response.statusCode).toBe(200);
    const spec = JSON.parse(response.body);
    expect(spec.paths).toEqual(openApiSpec.paths);
    expect(
      Object.keys(spec.paths).every((path) => path.startsWith("/v1/"))
    ).toBe(true);
  });

  it("every OpenAPI path resolves through Fastify routing", async () => {
    const checks = [
      { method: "GET", url: "/v1/health", expected: [200] },
      { method: "GET", url: "/v1/ready", expected: [200] },
      { method: "GET", url: "/v1/markets", expected: [200] },
      { method: "GET", url: `/v1/markets/${marketId}`, expected: [200] },
      {
        method: "GET",
        url: `/v1/markets/${marketId}/orderbook`,
        expected: [200],
      },
      {
        method: "POST",
        url: "/v1/orders",
        payload: {
          marketId,
          userAddress: wallet,
          side: "BUY",
          outcome: "YES",
          price: 0.5,
          quantity: 1,
        },
        // 401 when no x-signature/x-timestamp headers are supplied;
        // 201 when a correctly-signed request is sent.
        expected: [201, 401],
      },
      { method: "GET", url: `/v1/orders/user/${wallet}`, expected: [200] },
      { method: "GET", url: `/v1/trades/user/${wallet}`, expected: [200] },
      {
        method: "GET",
        url: `/v1/wallets/${wallet}/positions`,
        expected: [200],
      },
      {
        method: "GET",
        url: `/v1/wallets/${wallet}/positions/${marketId}`,
        expected: [200, 404],
      },
      { method: "GET", url: "/v1/admin/markets", expected: [401] },
      {
        method: "PATCH",
        url: `/v1/admin/markets/${marketId}/status`,
        payload: { status: "CANCELLED" },
        expected: [401],
      },
    ] as const;

    expect(Object.keys(openApiSpec.paths)).toHaveLength(checks.length);

    for (const check of checks) {
      const response = await app.inject(check);
      expect(response.statusCode, `${check.method} ${check.url}`).not.toBe(404);
      expect(check.expected).toContain(response.statusCode);
    }
  });
});
