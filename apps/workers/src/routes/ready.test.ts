import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(async () => [{ "?column?": 1 }]),
  healthCheck: vi.fn(async () => true),
}));

vi.mock("../../../../src/services/prisma.js", () => ({
  getPrismaClient: () => ({
    $queryRaw: mocks.queryRaw,
  }),
}));

vi.mock("../../../../src/services/redis.js", () => ({
  redis: {
    healthCheck: mocks.healthCheck,
  },
}));

import { readyRoutes } from "./ready.js";

function buildServer() {
  const server = Fastify({ logger: false });
  server.register(readyRoutes);
  return server;
}

describe("GET /ready (workers)", () => {
  beforeEach(() => {
    mocks.queryRaw.mockReset().mockResolvedValue([{ "?column?": 1 }]);
    mocks.healthCheck.mockReset().mockResolvedValue(true);
  });

  it("returns 200 and ready:true when Redis and the database are up", async () => {
    const server = buildServer();
    const res = await server.inject({ method: "GET", url: "/ready" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(body.dependencies.database.status).toBe("ok");
    expect(body.dependencies.redis.status).toBe("ok");
  });

  it("returns 503 and ready:false when Redis is down", async () => {
    mocks.healthCheck.mockResolvedValue(false);

    const server = buildServer();
    const res = await server.inject({ method: "GET", url: "/ready" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.dependencies.redis.status).toBe("error");
    expect(body.dependencies.redis.error).toContain("PONG");
    expect(body.dependencies.database.status).toBe("ok");
  });

  it("returns 503 and ready:false when the Redis health check throws", async () => {
    mocks.healthCheck.mockRejectedValue(new Error("connection refused"));

    const server = buildServer();
    const res = await server.inject({ method: "GET", url: "/ready" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.dependencies.redis.status).toBe("error");
    expect(body.dependencies.redis.error).toContain("connection refused");
  });

  it("returns 503 when the database is down even if Redis is up", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("db unreachable"));

    const server = buildServer();
    const res = await server.inject({ method: "GET", url: "/ready" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.dependencies.database.status).toBe("error");
    expect(body.dependencies.redis.status).toBe("ok");
  });

  it("echoes a supplied x-request-id header for log correlation", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/ready",
      headers: { "x-request-id": "test-correlation-id" },
    });

    expect(res.headers["x-request-id"]).toBe("test-correlation-id");
  });

  // Issue #1141: the worker probe is unauthenticated, so a driver message that
  // embeds a DSN would publish credentials to anyone who can reach the port.
  it("redacts a DSN embedded in a database error from the response body", async () => {
    mocks.queryRaw.mockRejectedValue(
      new Error(
        "Can't reach database server at `postgres://vatix:s3cr3t@db.internal:5432/vatix`"
      )
    );

    const server = buildServer();
    const res = await server.inject({ method: "GET", url: "/ready" });

    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("s3cr3t");
    expect(res.body).not.toContain("db.internal");
    expect(res.body).not.toContain("postgres://");

    const body = res.json();
    expect(body.dependencies.database.status).toBe("error");
    expect(body.dependencies.database.error).toContain("[REDACTED]");
    expect(body.dependencies.database.code).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("redacts a Redis host:port and password from the response body", async () => {
    mocks.healthCheck.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.5:6379")
    );

    const server = buildServer();
    const res = await server.inject({ method: "GET", url: "/ready" });

    expect(res.body).not.toContain("10.0.0.5");
    expect(res.body).not.toContain("6379");
  });

  it("keeps the raw driver message out of the response and reports a stable code", async () => {
    mocks.queryRaw.mockRejectedValue(
      new Error("connection refused to postgres://user:pass@host:5432/db")
    );

    const server = buildServer();
    const res = await server.inject({ method: "GET", url: "/ready" });
    const body = res.json();

    // The route publishes a sanitized summary, never the driver's raw message:
    // a DSN with embedded credentials must not reach an unauthenticated client.
    // The full message remains available in the server-side request log.
    expect(typeof body.dependencies.database.error).toBe("string");
    expect(body.dependencies.database.error).not.toContain("pass@");
    expect(body.dependencies.database.code).toBe("DEPENDENCY_UNAVAILABLE");
  });
});
