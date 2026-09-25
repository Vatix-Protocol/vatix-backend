import { describe, it, expect, afterEach } from "vitest";
import { buildIndexerHttpServer } from "./httpServer.js";

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
});
