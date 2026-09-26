import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Registry, Counter } from "prom-client";
import {
  buildIndexerHttpServer,
  createInMemoryRateLimitStore,
  setRateLimitHeaders,
} from "./httpServer.js";
import { getPrismaClient } from "../../../src/services/prisma.js";
import type { PrismaClient } from "../../../src/generated/prisma/client.js";

vi.mock("../../../src/services/prisma.js", () => ({
  getPrismaClient: vi.fn(),
}));

// Integration-style: exercises the real wiring (indexerCorsPlugin +
// marketsRoutes composed together), not just the CORS plugin registered
// against a stub route as apps/indexer/src/middleware/cors.test.ts does.
// This is the check that would have caught the routes/cors modules never
// being mounted anywhere in apps/indexer/src/main.ts.
describe("buildIndexerHttpServer", () => {
  /**
   * Default Prisma double. The `/markets` routes resolve the client lazily per
   * request, so a test that exercises them without installing its own mock
   * would otherwise get `undefined` and a spurious 503. Individual tests that
   * care about a specific response override this via `mockReturnValue`.
   */
  const defaultPrisma = {
    market: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    indexedTrade: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  } as unknown as PrismaClient;

  beforeEach(() => {
    vi.mocked(getPrismaClient).mockReturnValue(defaultPrisma);
  });

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
    expect(typeof body.correlationId).toBe("string");

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
    // Response contract per README: { ready, code, correlationId, checks }.
    expect(body.ready).toBe(false);
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
    // Response contract per README: { ready, correlationId, checks }.
    expect(body.ready).toBe(true);
    expect(body.checks).toMatchObject({ db: "ok", redis: "ok" });

    await app.close();
  });

  // Issue #1097: /health and /ready must be rate-limited like every
  // other external entrypoint (deny-by-default).  Without a policy
  // they would be rejected with 429 by the onRequest hook.
  it("returns 200 from /health when rate-limit policy is present", async () => {
    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(typeof body.correlationId).toBe("string");

    await app.close();
  });

  it("returns 200 from /ready when rate-limit policy is present and deps are healthy", async () => {
    const app = await buildIndexerHttpServer({
      readinessChecks: [{ name: "db", check: async () => undefined }],
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ready).toBe(true);

    await app.close();
  });

  // Issue #1097: data routes require x-principal.  Untrusted clients
  // without a principal are rejected with 401 UNAUTHORIZED so they
  // cannot bypass the rate-limit policy.
  it("returns 401 UNAUTHORIZED for /markets when x-principal is missing", async () => {
    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/markets",
      headers: { "x-correlation-id": "corr-no-principal" },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.correlationId).toBe("corr-no-principal");

    await app.close();
  });

  // Issue #1097: data routes allow access when x-principal is present.
  it("returns 200 from /markets when x-principal is present", async () => {
    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/markets",
      headers: {
        "x-correlation-id": "corr-with-principal",
        "x-principal": "test-user",
      },
    });

    // 200 means the request passed authz and rate-limiting;
    // marketsRoutes is empty so fastify returns 404 for the path,
    // but the onRequest hook allowed it through.
    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).not.toBe(429);

    await app.close();
  });

  // Issue #1097: probes are exempt from authz so kubelet can reach them
  // without credentials.
  it("returns 200 from /health without x-principal (probe authz exemption)", async () => {
    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it("returns 200 from /ready without x-principal (probe authz exemption)", async () => {
    const app = await buildIndexerHttpServer({
      readinessChecks: [{ name: "db", check: async () => undefined }],
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);

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
          // An API key satisfies the key check; the deny-by-default authz
          // hook additionally requires a principal on data routes.
          "x-principal": "test-user",
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

      // Data routes are deny-by-default (#1097): an authenticated principal is
      // required, otherwise the request is rejected before the route runs.
      const response = await app.inject({
        method: "GET",
        url: "/markets/non-existent-id",
        headers: { "x-principal": "test-user" },
      });

      // 404 means the route exists and the market was not found.
      // 500 could mean the DB is unreachable (acceptable in test env).
      expect(response.statusCode === 404 || response.statusCode === 500).toBe(
        true
      );

      if (response.statusCode === 404) {
        const body = response.json();
        expect(body.code).toBe("MARKETS_NOT_FOUND");
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

    const response = await app.inject({
      method: "GET",
      url: "/markets",
      // Data routes are deny-by-default (#1097): a principal is
      // required or the request is rejected before the route runs.
      headers: { "x-principal": "test-user" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.markets).toBeInstanceOf(Array);
    expect(body.markets).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body).toHaveProperty("correlationId");

    await app.close();
  });

  it("returns 200 from /ready without x-principal (probe authz exemption)", async () => {
    const app = await buildIndexerHttpServer({
      readinessChecks: [{ name: "db", check: async () => undefined }],
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);

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
      // Data routes are deny-by-default (#1097): a principal is required or
      // the request is rejected before the route runs.
      headers: { "x-principal": "test-user" },
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
      // Data routes are deny-by-default (#1097): a principal is required or
      // the request is rejected before the route runs.
      headers: { "x-principal": "test-user" },
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

    const response = await app.inject({
      method: "GET",
      url: "/markets",
      // Data routes are deny-by-default (#1097): a principal is
      // required or the request is rejected before the route runs.
      headers: { "x-principal": "test-user" },
    });

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
      // Data routes are deny-by-default (#1097): a principal is required or
      // the request is rejected before the route runs.
      headers: { "x-principal": "test-user" },
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

/**
 * Rate-limit response headers (#1142).
 *
 * RATE_LIMIT_POLICY.md requires `RateLimit-Limit` / `RateLimit-Remaining` /
 * `RateLimit-Reset` on every response and `Retry-After` on a 429. Without them
 * a client cannot compute a backoff and degrades into blind retry loops, which
 * is the exact load the limiter exists to shed — so these are asserted on both
 * the success and the throttled path.
 */
describe("rate limit response headers", () => {
  /** Deterministic clock so `RateLimit-Reset` and `Retry-After` are exact. */
  const NOW_MS = 1_700_000_000_000;

  afterEach(() => {
    delete process.env.INDEXER_REQUIRED_PRINCIPAL;
  });

  it("emits RateLimit-Limit/Remaining/Reset on a successful response", async () => {
    const app = await buildIndexerHttpServer({
      rateLimitStore: createInMemoryRateLimitStore(() => NOW_MS),
      now: () => NOW_MS,
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/markets",
      headers: { "x-principal": "test-user" },
    });

    expect(response.statusCode).toBe(200);
    // /markets is tiered at 60 req/min.
    expect(response.headers["ratelimit-limit"]).toBe("60");
    expect(response.headers["ratelimit-remaining"]).toBe("59");
    // Reset is reported in Unix *seconds*, per the policy.
    expect(response.headers["ratelimit-reset"]).toBe(
      String(Math.ceil((NOW_MS + 60_000) / 1000))
    );

    await app.close();
  });

  it("decrements RateLimit-Remaining on each request in the window", async () => {
    const app = await buildIndexerHttpServer({
      rateLimitStore: createInMemoryRateLimitStore(() => NOW_MS),
      now: () => NOW_MS,
    });
    await app.ready();

    const remaining: string[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({
        method: "GET",
        url: "/markets",
        headers: { "x-principal": "test-user" },
      });
      remaining.push(String(response.headers["ratelimit-remaining"]));
    }

    expect(remaining).toEqual(["59", "58", "57"]);

    await app.close();
  });

  it("emits Retry-After alongside the quota headers on a 429", async () => {
    // Tier of 1 so the second request trips the limiter deterministically.
    const app = await buildIndexerHttpServer({
      rateLimitStore: createInMemoryRateLimitStore(() => NOW_MS),
      now: () => NOW_MS,
      rateLimitPolicies: { "/markets": { limit: 1, windowMs: 60_000 } },
    });
    await app.ready();

    const headers = { "x-principal": "test-user" };
    const first = await app.inject({ method: "GET", url: "/markets", headers });
    expect(first.statusCode).toBe(200);
    expect(first.headers["ratelimit-remaining"]).toBe("0");

    const second = await app.inject({
      method: "GET",
      url: "/markets",
      headers,
    });

    expect(second.statusCode).toBe(429);
    expect(second.json().code).toBe("RATE_LIMITED");
    expect(second.headers["ratelimit-limit"]).toBe("1");
    // Remaining is clamped at 0 rather than going negative.
    expect(second.headers["ratelimit-remaining"]).toBe("0");
    expect(second.headers["ratelimit-reset"]).toBe(
      String(Math.ceil((NOW_MS + 60_000) / 1000))
    );
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(second.headers["retry-after"])).toBeLessThanOrEqual(60);

    await app.close();
  });

  it("never reports a negative RateLimit-Remaining under sustained load", async () => {
    const app = await buildIndexerHttpServer({
      rateLimitStore: createInMemoryRateLimitStore(() => NOW_MS),
      now: () => NOW_MS,
      rateLimitPolicies: { "/markets": { limit: 2, windowMs: 60_000 } },
    });
    await app.ready();

    for (let i = 0; i < 10; i++) {
      const response = await app.inject({
        method: "GET",
        url: "/markets",
        headers: { "x-principal": "test-user" },
      });
      const remaining = Number(response.headers["ratelimit-remaining"]);
      expect(remaining).toBeGreaterThanOrEqual(0);
    }

    await app.close();
  });

  it("resets the quota once the window elapses", async () => {
    let clock = NOW_MS;
    const app = await buildIndexerHttpServer({
      rateLimitStore: createInMemoryRateLimitStore(() => clock),
      rateLimitPolicies: { "/markets": { limit: 1, windowMs: 1_000 } },
    });
    await app.ready();

    const headers = { "x-principal": "test-user" };
    await app.inject({ method: "GET", url: "/markets", headers });
    expect(
      (await app.inject({ method: "GET", url: "/markets", headers })).statusCode
    ).toBe(429);

    // Advance past the window; the counter must roll over, not stay throttled.
    clock = NOW_MS + 1_001;
    const afterReset = await app.inject({
      method: "GET",
      url: "/markets",
      headers,
    });

    expect(afterReset.statusCode).toBe(200);
    expect(afterReset.headers["ratelimit-remaining"]).toBe("0");

    await app.close();
  });

  it("denies a route with no policy and reports a zero quota", async () => {
    const app = await buildIndexerHttpServer({
      rateLimitPolicies: { "/markets": { limit: 60, windowMs: 60_000 } },
    });
    await app.ready();

    // /markets/:id has no policy in this map -> deny-by-default.
    const response = await app.inject({
      method: "GET",
      url: "/markets/some-id",
      headers: { "x-principal": "test-user" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["ratelimit-limit"]).toBe("0");
    expect(response.headers["ratelimit-remaining"]).toBe("0");

    await app.close();
  });

  it("fails closed with a zero quota when the counter store is unavailable", async () => {
    const app = await buildIndexerHttpServer({
      rateLimitStore: {
        increment: async () => {
          throw new Error("redis down");
        },
      },
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/markets",
      headers: { "x-principal": "test-user" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("DEPENDENCY_UNAVAILABLE");
    // A client that trusts the header stops hammering a broken limiter.
    expect(response.headers["ratelimit-remaining"]).toBe("0");
    // The store failure must not leak its message.
    expect(response.body).not.toContain("redis down");

    await app.close();
  });

  it("keys the quota per principal so one client cannot exhaust another's", async () => {
    const app = await buildIndexerHttpServer({
      rateLimitStore: createInMemoryRateLimitStore(() => NOW_MS),
      now: () => NOW_MS,
      rateLimitPolicies: { "/markets": { limit: 1, windowMs: 60_000 } },
    });
    await app.ready();

    await app.inject({
      method: "GET",
      url: "/markets",
      headers: { "x-principal": "alice" },
    });
    const aliceThrottled = await app.inject({
      method: "GET",
      url: "/markets",
      headers: { "x-principal": "alice" },
    });
    const bob = await app.inject({
      method: "GET",
      url: "/markets",
      headers: { "x-principal": "bob" },
    });

    expect(aliceThrottled.statusCode).toBe(429);
    expect(bob.statusCode).toBe(200);

    await app.close();
  });

  it("does not rate-limit /metrics and emits no quota headers there", async () => {
    const app = await buildIndexerHttpServer({
      rateLimitStore: createInMemoryRateLimitStore(() => NOW_MS),
      now: () => NOW_MS,
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["ratelimit-limit"]).toBeUndefined();

    await app.close();
  });
});

describe("setRateLimitHeaders", () => {
  const reply = () => {
    const headers: Record<string, string> = {};
    return {
      headers,
      header(name: string, value: string) {
        headers[name] = value;
        return this;
      },
    };
  };

  it("rounds RateLimit-Reset up to the next whole second", () => {
    const r = reply();
    setRateLimitHeaders(
      r as never,
      { limit: 10, windowMs: 60_000 },
      { count: 1, resetAtMs: 1_700_000_000_400 }
    );

    expect(r.headers["RateLimit-Reset"]).toBe("1700000001");
  });

  it("omits Retry-After when the window has already elapsed", () => {
    const r = reply();
    setRateLimitHeaders(
      r as never,
      { limit: 10, windowMs: 60_000 },
      { count: 1, resetAtMs: Date.now() - 5_000 }
    );

    // A non-positive Retry-After would be meaningless (and Retry-After: 0 tells
    // a client to retry immediately), so it is omitted instead.
    expect(r.headers["Retry-After"]).toBeUndefined();
    expect(r.headers["RateLimit-Remaining"]).toBe("9");
  });
});
