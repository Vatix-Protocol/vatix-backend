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
});
