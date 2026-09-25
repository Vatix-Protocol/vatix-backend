import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import {
  readyRoute,
  INDEX_STALENESS_THRESHOLD_MS,
  type ReadyDeps,
} from "./ready.js";

const NOW = 1_700_000_000_000;

afterEach(() => {
  vi.unstubAllEnvs();
});

function buildServer(deps: ReadyDeps) {
  const server = Fastify({ logger: false });
  server.register(readyRoute(deps), { prefix: "/v1" });
  return server;
}

const freshDeps: ReadyDeps = {
  checkDatabase: async () => {},
  checkRedis: async () => {},
  getLastIndexedAt: async () => NOW - 1000, // 1 second old — fresh
  now: () => NOW,
};

describe("GET /v1/ready", () => {
  it("returns 200 and ready:true when all dependencies are healthy", async () => {
    const server = buildServer(freshDeps);
    const res = await server.inject({ method: "GET", url: "/v1/ready" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(body.code).toBe("OK");
    expect(typeof body.correlationId).toBe("string");
    expect(body.correlationId).not.toBe("");
    expect(body.dependencies.database.status).toBe("ok");
    expect(body.dependencies.indexFreshness.status).toBe("ok");
  });

  it("returns 503 and ready:false when the database check fails", async () => {
    const server = buildServer({
      ...freshDeps,
      checkDatabase: async () => {
        throw new Error("connection refused");
      },
    });

    const res = await server.inject({ method: "GET", url: "/v1/ready" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(body.dependencies.database.status).toBe("error");
    // #1141: raw driver errors must never reach the probe response —
    // only a coarse, fixed reason.
    expect(body.dependencies.database.error).not.toContain(
      "connection refused"
    );
    expect(body.dependencies.database.error).toBe("Database check failed");
  });

  it("never leaks connection strings, credentials, or hostnames (#1141)", async () => {
    const secretError =
      "Can't reach database server at `db.internal:5432` " +
      "(postgresql://postgres:supersecret@db.internal:5432/vatix)";
    const server = buildServer({
      ...freshDeps,
      checkDatabase: async () => {
        throw new Error(secretError);
      },
      checkRedis: async () => {
        throw new Error("invalid URL redis://:redispass@cache:6379");
      },
    });

    const res = await server.inject({ method: "GET", url: "/v1/ready" });

    expect(res.statusCode).toBe(503);
    const raw = res.body;
    expect(raw).not.toContain("supersecret");
    expect(raw).not.toContain("redispass");
    expect(raw).not.toContain("db.internal");
    expect(raw).not.toContain("postgresql://");
    expect(raw).not.toContain("cache:6379");
  });

  it("returns 503 and ready:false when the index is stale", async () => {
    const server = buildServer({
      ...freshDeps,
      getLastIndexedAt: async () => NOW - INDEX_STALENESS_THRESHOLD_MS - 1000, // 1 second past threshold
    });

    const res = await server.inject({ method: "GET", url: "/v1/ready" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.dependencies.indexFreshness.status).toBe("stale");
  });

  it("returns 503 when no events have been indexed yet", async () => {
    const server = buildServer({
      ...freshDeps,
      getLastIndexedAt: async () => null,
    });

    const res = await server.inject({ method: "GET", url: "/v1/ready" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.dependencies.indexFreshness.status).toBe("stale");
    expect(body.dependencies.indexFreshness.error).toContain(
      "No indexed events found"
    );
  });

  it("returns 503 when the index freshness check throws", async () => {
    const server = buildServer({
      ...freshDeps,
      getLastIndexedAt: async () => {
        throw new Error("query timeout");
      },
    });

    const res = await server.inject({ method: "GET", url: "/v1/ready" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(body.dependencies.indexFreshness.status).toBe("error");
    // #1141: raw query errors stay in logs; the response carries a coarse
    // reason only.
    expect(body.dependencies.indexFreshness.error).not.toContain(
      "query timeout"
    );
    expect(body.dependencies.indexFreshness.error).toBe(
      "Index freshness check failed"
    );
  });

  it("fails closed as DEPENDENCY_TIMEOUT when a check exceeds its deadline", async () => {
    vi.stubEnv("READY_CHECK_TIMEOUT_MS", "50");
    const server = buildServer({
      ...freshDeps,
      // Never settles — must be cut off by the per-check deadline.
      checkDatabase: () => new Promise<void>(() => {}),
    });

    const res = await server.inject({ method: "GET", url: "/v1/ready" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.code).toBe("DEPENDENCY_TIMEOUT");
    expect(body.dependencies.database.status).toBe("error");
    expect(body.dependencies.database.error).toBe("Dependency check timed out");
    vi.unstubAllEnvs();
  });

  it("echoes the x-correlation-id request header in the body and response", async () => {
    const server = buildServer(freshDeps);
    const res = await server.inject({
      method: "GET",
      url: "/v1/ready",
      headers: { "x-correlation-id": "corr-ready-1" },
    });

    const body = res.json();
    expect(body.correlationId).toBe("corr-ready-1");
    expect(res.headers["x-correlation-id"]).toBe("corr-ready-1");
  });

  it("response body lists all dependency statuses", async () => {
    const server = buildServer(freshDeps);
    const res = await server.inject({ method: "GET", url: "/v1/ready" });
    const body = res.json();

    expect(body.dependencies).toHaveProperty("database");
    expect(body.dependencies).toHaveProperty("indexFreshness");
  });

  it("returns 503 when both dependencies fail", async () => {
    const server = buildServer({
      checkDatabase: async () => {
        throw new Error("db down");
      },
      checkRedis: async () => {
        throw new Error("redis down");
      },
      getLastIndexedAt: async () => {
        throw new Error("index down");
      },
      now: () => NOW,
    });

    const res = await server.inject({ method: "GET", url: "/v1/ready" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.dependencies.database.status).toBe("error");
    expect(body.dependencies.indexFreshness.status).toBe("error");
  });
});
