import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import {
  readyRoute,
  INDEX_STALENESS_THRESHOLD_MS,
  type ReadyDeps,
} from "./ready.js";

const NOW = 1_700_000_000_000;

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
    expect(body.dependencies.database.status).toBe("error");
    expect(body.dependencies.database.error).toContain("connection refused");
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
    expect(body.dependencies.indexFreshness.status).toBe("error");
    expect(body.dependencies.indexFreshness.error).toContain("query timeout");
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

  // Issue #1141: /v1/ready is unauthenticated, so a raw driver message that
  // embeds a DSN would publish credentials to anyone who can reach the port.
  it("redacts a DSN embedded in a database error from the response body", async () => {
    const server = buildServer({
      ...freshDeps,
      checkDatabase: async () => {
        throw new Error(
          "Can't reach database server at `postgres://vatix:s3cr3t@db.internal:5432/vatix`"
        );
      },
    });

    const res = await server.inject({ method: "GET", url: "/v1/ready" });

    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("s3cr3t");
    expect(res.body).not.toContain("db.internal");
    expect(res.body).not.toContain("postgres://");

    const body = res.json();
    expect(body.dependencies.database.status).toBe("error");
    expect(body.dependencies.database.error).toContain("[REDACTED]");
  });

  it("redacts a Redis host:port and password from the response body", async () => {
    const server = buildServer({
      ...freshDeps,
      checkRedis: async () => {
        throw new Error(
          "connect ECONNREFUSED 10.0.0.5:6379 (redis://:pw@cache)"
        );
      },
    });

    const res = await server.inject({ method: "GET", url: "/v1/ready" });

    expect(res.body).not.toContain("10.0.0.5");
    expect(res.body).not.toContain(":6379");
    expect(res.body).not.toContain("redis://");
  });

  it("exposes a stable code for every failed dependency", async () => {
    const server = buildServer({
      ...freshDeps,
      checkDatabase: async () => {
        throw Object.assign(new Error("boom"), { code: "ETIMEDOUT" });
      },
    });

    const res = await server.inject({ method: "GET", url: "/v1/ready" });
    const body = res.json();

    expect(body.dependencies.database.code).toBe("PROBE_TIMEOUT");
  });

  it("classifies a not-yet-indexed index with a stable code", async () => {
    const server = buildServer({
      ...freshDeps,
      getLastIndexedAt: async () => null,
    });

    const res = await server.inject({ method: "GET", url: "/v1/ready" });
    const body = res.json();

    expect(body.dependencies.indexFreshness.status).toBe("stale");
    expect(body.dependencies.indexFreshness.code).toBe("NO_DATA");
  });
});
