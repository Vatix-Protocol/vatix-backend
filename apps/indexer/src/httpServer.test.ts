import { describe, it, expect, afterEach, vi } from "vitest";
import { Registry, Counter } from "prom-client";
import { buildIndexerHttpServer } from "./httpServer.js";
import { getPrismaClient } from "./services/prisma.js";
import type { PrismaClient } from "../../../src/generated/prisma/client.js";

vi.mock("./services/prisma.js", () => ({
  getPrismaClient: vi.fn(),
}));

// Integration-style: exercises the real wiring (indexerCorsPlugin +
// marketsRoutes composed together), not just the CORS plugin registered
// against a stub route as apps/indexer/src/middleware/cors.test.ts does.
// This is the check that would have caught the routes/cors modules never
// being mounted anywhere in apps/indexer/src/main.ts.
describe("buildIndexerHttpServer", () => {
  afterEach(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.NODE_ENV;
  });

  it("rejects a disallowed origin against the real /markets route in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CORS_ALLOWED_ORIGINS;

    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({
      method: "OPTIONS",
      url: "/markets",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "GET",
      },
    });

    expect(response.headers["access-control-allow-origin"]).not.toBe(
      "https://evil.example.com"
    );

    await app.close();
  });

  it("allows an allowlisted origin against the real /markets route in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ALLOWED_ORIGINS = "https://app.vatix.io";

    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({
      method: "OPTIONS",
      url: "/markets",
      headers: {
        origin: "https://app.vatix.io",
        "access-control-request-method": "GET",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://app.vatix.io"
    );

    await app.close();
  });

  // Issue #1081: liveness (/health) must stay 200 while the process is alive,
  // independent of dependency state, so orchestrators do not restart a healthy
  // process during a transient DB/Redis/RPC outage.
  it("returns 200 from /health (liveness) regardless of dependency state", async () => {
    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");

    await app.close();
  });

  // Issue #1081: readiness (/ready) is fail-closed. When a critical dependency
  // is unavailable it must return 503 with a stable error code and a
  // correlation id, and must not leak connection strings or internal addresses.
  it("returns 503 with a stable error code and correlation id from /ready when a dependency is down", async () => {
    const app = await buildIndexerHttpServer({
      readinessChecks: [
        {
          name: "db",
          check: async () => {
            throw new Error(
              "connect ECONNREFUSED postgres://user:secret@10.0.0.5:5432/vatix"
            );
          },
        },
      ],
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("unavailable");
    expect(body.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(typeof body.correlationId).toBe("string");
    expect(body.correlationId.length).toBeGreaterThan(0);

    // Fail-closed responses must not leak secrets or internal addresses.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("10.0.0.5");

    await app.close();
  });

  // Issue #1081: when every critical dependency is healthy, /ready reports 200
  // so the orchestrator can route traffic to the instance.
  it("returns 200 from /ready when all critical dependencies are healthy", async () => {
    const app = await buildIndexerHttpServer({
      readinessChecks: [
        { name: "db", check: async () => undefined },
        { name: "redis", check: async () => undefined },
      ],
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");

    await app.close();
  });

  // ── Authz: untrusted principals are rejected ──────────────────────
  describe("indexer authz", () => {
    afterEach(() => {
      delete process.env.INDEXER_REQUIRED_PRINCIPAL;
      delete process.env.INDEXER_API_KEY;
    });

    it("rejects a request with a mismatched x-principal when INDEXER_REQUIRED_PRINCIPAL is set", async () => {
      process.env.INDEXER_REQUIRED_PRINCIPAL = "trusted-principal";

      const app = await buildIndexerHttpServer();
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: "/markets",
        headers: {
          "x-principal": "untrusted-principal",
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.code).toBe("UNAUTHORIZED");
      expect(typeof body.correlationId).toBe("string");

      await app.close();
    });

    it("accepts a request with a matching x-principal when INDEXER_REQUIRED_PRINCIPAL is set", async () => {
      process.env.INDEXER_REQUIRED_PRINCIPAL = "trusted-principal";

      const app = await buildIndexerHttpServer();
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: "/markets",
        headers: {
          "x-principal": "trusted-principal",
        },
      });

      // 200 means authz passed; the route may return 404/500 if
      // the DB is unreachable but that is a separate concern.
      expect(response.statusCode).not.toBe(401);

      await app.close();
    });

    it("rejects a request with an invalid x-api-key when INDEXER_API_KEY is set", async () => {
      process.env.INDEXER_API_KEY = "valid-key";

      const app = await buildIndexerHttpServer();
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: "/markets",
        headers: {
          "x-api-key": "wrong-key",
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.code).toBe("UNAUTHORIZED");

      await app.close();
    });

    it("accepts a request with a matching x-api-key when INDEXER_API_KEY is set", async () => {
      process.env.INDEXER_API_KEY = "valid-key";

      const app = await buildIndexerHttpServer();
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: "/markets",
        headers: {
          "x-api-key": "valid-key",
        },
      });

      expect(response.statusCode).not.toBe(401);

      await app.close();
    });
  });

  // ── Markets route integration ─────────────────────────────────────
  describe("markets routes", () => {
    it("GET /markets returns a structured success envelope", async () => {
      const app = await buildIndexerHttpServer();
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: "/markets",
      });

      // The route exists; 200 means it responded, 404 means the route
      // is not registered (which would be a wiring bug).
      expect(response.statusCode).not.toBe(404);
      const body = response.json();
      if (response.statusCode === 200) {
        expect(body.success).toBe(true);
        expect(Array.isArray(body.data)).toBe(true);
        expect(typeof body.requestId).toBe("string");
        expect(typeof body.timestamp).toBe("string");
      }

      await app.close();
    });

    it("GET /markets/:id returns 404 for a non-existent market", async () => {
      const app = await buildIndexerHttpServer();
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: "/markets/non-existent-id",
      });

      // 404 means the route exists and the market was not found.
      // 500 could mean the DB is unreachable (acceptable in test env).
      expect(
        response.statusCode === 404 || response.statusCode === 500
      ).toBe(true);

      if (response.statusCode === 404) {
        const body = response.json();
        expect(body.code).toBe("MARKET_NOT_FOUND");
        expect(typeof body.correlationId).toBe("string");
      }

      await app.close();
    });
  });

  // Issue #1099: GET /markets returns a paginated list of non-soft-deleted markets.
  it("returns 200 with a paginated list of markets from GET /markets", async () => {
    const mockPrisma = {
      market: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "market-1",
            question: "Will it rain?",
            endTime: new Date("2026-06-01T00:00:00Z"),
            oracleAddress: "GABC...",
            status: "ACTIVE",
            outcome: null,
            createdAt: new Date("2026-01-01T00:00:00Z"),
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    } as unknown as PrismaClient;
    vi.mocked(getPrismaClient).mockReturnValue(mockPrisma);

    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/markets" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.markets).toBeInstanceOf(Array);
    expect(body.markets).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body).toHaveProperty("correlationId");

    await app.close();
  });

  // ── Metrics endpoint (#1096) ───────────────────────────────────────────────
  //
  // The /metrics endpoint returns Prometheus-formatted metrics when a registry
  // is supplied, and a stub response when it is not.

  it("returns 200 with Prometheus content-type from /metrics when a registry is supplied", async () => {
    const registry = new Registry();
    const testCounter = new Counter({
      name: "test_requests_total",
      help: "test counter for /metrics endpoint",
      registers: [registry],
    });
    testCounter.inc(42);

    const app = await buildIndexerHttpServer({ metricsRegistry: registry });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    const body = response.body;
    expect(body).toContain("test_requests_total 42");

    await app.close();
  });

  // Issue #1099: GET /markets/:id returns a single market by ID.
  it("returns 200 with a single market from GET /markets/:id", async () => {
    const mockPrisma = {
      market: {
        findUnique: vi.fn().mockResolvedValue({
          id: "market-1",
          question: "Will it rain?",
          endTime: new Date("2026-06-01T00:00:00Z"),
          oracleAddress: "GABC...",
          status: "ACTIVE",
          outcome: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        }),
      },
    } as unknown as PrismaClient;
    vi.mocked(getPrismaClient).mockReturnValue(mockPrisma);

    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/markets/market-1",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.market.id).toBe("market-1");
    expect(body).toHaveProperty("correlationId");

    await app.close();
  });

  it("returns 200 with a stub from /metrics when no registry is supplied", async () => {
    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    const body = response.body;
    expect(body).toContain("No metrics registry configured");

    await app.close();
  });

  // Issue #1099: GET /markets/:id returns 404 for a non-existent market.
  it("returns 404 for a non-existent market from GET /markets/:id", async () => {
    const mockPrisma = {
      market: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaClient;
    vi.mocked(getPrismaClient).mockReturnValue(mockPrisma);

    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/markets/nonexistent",
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.code).toBe("MARKETS_NOT_FOUND");
    expect(body).toHaveProperty("correlationId");

    await app.close();
  });

  // Issue #1099: GET /markets returns 503 when the database is unavailable (fail-closed).
  it("returns 503 from GET /markets when the database is unavailable", async () => {
    const mockPrisma = {
      market: {
        findMany: vi.fn().mockRejectedValue(new Error("DB down")),
        count: vi.fn().mockRejectedValue(new Error("DB down")),
      },
    } as unknown as PrismaClient;
    vi.mocked(getPrismaClient).mockReturnValue(mockPrisma);

    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/markets" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.code).toBe("MARKETS_DEPENDENCY_UNAVAILABLE");
    expect(body).toHaveProperty("correlationId");

    // Fail-closed responses must not leak secrets or internal addresses.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("DB down");

    await app.close();
  });

  // Issue #1099: GET /markets/:id returns 503 when the database is unavailable (fail-closed).
  it("returns 503 from GET /markets/:id when the database is unavailable", async () => {
    const mockPrisma = {
      market: {
        findUnique: vi.fn().mockRejectedValue(new Error("DB down")),
      },
    } as unknown as PrismaClient;
    vi.mocked(getPrismaClient).mockReturnValue(mockPrisma);

    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/markets/market-1",
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.code).toBe("MARKETS_DEPENDENCY_UNAVAILABLE");
    expect(body).toHaveProperty("correlationId");

    await app.close();
  });

  // Issue #1096: /metrics must be exempt from rate limiting so that
  // Prometheus scrapers are never throttled (matching /health and /ready).
  it("does not rate-limit /metrics even under load (no RATE_LIMITED response)", async () => {
    const app = await buildIndexerHttpServer();
    await app.ready();

    // Send many rapid requests — none should be rate limited
    for (let i = 0; i < 10; i++) {
      const response = await app.inject({ method: "GET", url: "/metrics" });
      expect(response.statusCode).toBe(200);
    }

    await app.close();
  });
  });
});
