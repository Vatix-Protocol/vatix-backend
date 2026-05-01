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
      getLastIndexedAt: async () =>
        NOW - INDEX_STALENESS_THRESHOLD_MS - 1000, // 1 second past threshold
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
