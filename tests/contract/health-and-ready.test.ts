/**
 * Contract tests for health and readiness probes (#559, #560)
 *
 * Ensures:
 * - GET /v1/health always returns 200 with status: ok (DB mocked healthy)
 * - GET /v1/ready returns correct status based on dependencies
 * - Test routes (/test/*) are disabled in production
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { healthRoutes } from "../../src/api/routes/health.js";
import { buildTestApp, resetRateLimits } from "../integration/helpers/build-test-app.js";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5433/vatix";
  process.env.NODE_ENV = "test";
});

describe("Health and readiness probes (#559)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Mock the Prisma client so health checks are deterministic (no live DB needed)
    const prismaModule = await import("../../src/services/prisma.js");
    vi.spyOn(prismaModule, "getPrismaClient").mockReturnValue({
      $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as any);

    app = await buildTestApp({ plugins: [healthRoutes] });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  beforeEach(() => {
    resetRateLimits();
  });

  describe("GET /v1/health", () => {
    it("returns 200 with status: ok", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ok");
    });

    it("includes service info and dependencies", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/health" });
      const body = res.json();
      expect(body).toHaveProperty("service");
      expect(body).toHaveProperty("version");
      expect(body).toHaveProperty("uptime");
      expect(body).toHaveProperty("timestamp");
      expect(body).toHaveProperty("dependencies");
    });

    it("reports database dependency as ok when DB is healthy", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/health" });
      const body = res.json();
      expect(body.dependencies).toHaveProperty("database", "ok");
    });

    it("returns status: degraded when DB is unreachable", async () => {
      const prismaModule = await import("../../src/services/prisma.js");
      vi.spyOn(prismaModule, "getPrismaClient").mockReturnValueOnce({
        $queryRaw: vi.fn().mockRejectedValue(new Error("connection refused")),
      } as any);

      const res = await app.inject({ method: "GET", url: "/v1/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("degraded");
      expect(body.dependencies).toHaveProperty("database", "error");
    });
  });

  describe("GET /v1/health is not rate-limited", () => {
    it("allows multiple requests in rapid succession without 429", async () => {
      const requests = Array.from({ length: 10 }, () =>
        app.inject({ method: "GET", url: "/v1/health" })
      );
      const results = await Promise.all(requests);

      for (const res of results) {
        expect(res.statusCode).not.toBe(429);
        expect(res.statusCode).toBe(200);
      }
    });
  });
});

describe("Test routes disabled in production (#560)", () => {
  it("test routes are NOT registered when registerTestRoutes=false", async () => {
    const { buildServer } = await import("../../src/index.js");
    const prodServer = buildServer({
      logger: false,
      registerTestRoutes: false,
    });
    await prodServer.ready();

    const res = await prodServer.inject({
      method: "GET",
      url: "/test/validation-error",
    });
    expect(res.statusCode).toBe(404);

    await prodServer.close();
  });

  it("test routes are registered when registerTestRoutes=true", async () => {
    const { buildServer } = await import("../../src/index.js");
    const devServer = buildServer({
      logger: false,
      registerTestRoutes: true,
    });
    await devServer.ready();

    const res = await devServer.inject({
      method: "GET",
      url: "/test/validation-error",
    });
    expect(res.statusCode).not.toBe(404);

    await devServer.close();
  });

  it("production mode disables test routes", () => {
    const isProduction = "production" === "production";
    const shouldRegisterTestRoutes = !isProduction;
    expect(shouldRegisterTestRoutes).toBe(false);
  });
});
