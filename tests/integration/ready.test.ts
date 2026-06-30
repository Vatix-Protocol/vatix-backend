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

// Mock the prisma service
const mockFindFirst = vi.fn();
vi.mock("../../src/services/prisma.js", () => {
  return {
    getPrismaClient: () => ({
      $queryRaw: async () => {},
      indexerCursor: {
        findFirst: mockFindFirst,
      },
    }),
  };
});

describe("Ready Integration Tests", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INDEX_STALENESS_THRESHOLD_MS = "300000";
    app = buildServer({
      logger: false,
      registerTestRoutes: true,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 503 when no indexer cursor exists yet", async () => {
    mockFindFirst.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.dependencies.indexFreshness.status).toBe("stale");
  });

  it("returns 200 when fresh indexer cursor exists", async () => {
    mockFindFirst.mockResolvedValue({
      networkId: "testnet",
      cursorKey: "ingestion",
      cursorValue: "123456",
      updatedAt: new Date(),
    });

    const res = await app.inject({ method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(body.dependencies.database.status).toBe("ok");
    expect(body.dependencies.indexFreshness.status).toBe("ok");
  });

  it("returns 503 when indexer cursor is stale", async () => {
    mockFindFirst.mockResolvedValue({
      networkId: "testnet",
      cursorKey: "ingestion",
      cursorValue: "123456",
      updatedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min old
    });

    const res = await app.inject({ method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.dependencies.indexFreshness.status).toBe("stale");
  });

  it("returns 301 redirect for legacy /readiness endpoint", async () => {
    const res = await app.inject({ method: "GET", url: "/readiness" });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe("/v1/ready");
    expect(res.headers.deprecation).toBe("true");
  });

  it("gates test routes when NODE_ENV is production", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const prodApp = buildServer({
      logger: false,
      registerTestRoutes: false,
    });
    await prodApp.ready();

    const res = await prodApp.inject({
      method: "GET",
      url: "/test/server-error",
    });
    expect(res.statusCode).toBe(404);

    await prodApp.close();
    process.env.NODE_ENV = originalEnv;
  });
});
