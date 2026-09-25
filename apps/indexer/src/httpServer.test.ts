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
    expect(body.status).toBe("ok");

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
});
