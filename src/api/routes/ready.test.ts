import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  readyRoute,
  beginDrain,
  isDraining,
  resetDrainForTests,
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
});

/**
 * Drain-on-shutdown (#1140).
 *
 * On SIGTERM the API flips readiness BEFORE closing the listener, so the load
 * balancer stops routing to an instance that is refusing connections. Without
 * this, /v1/ready keeps answering 200 during teardown and every request the LB
 * sends in that window fails at the client.
 */
describe("readiness during graceful shutdown (#1140)", () => {
  beforeEach(() => {
    resetDrainForTests();
  });

  it("starts not draining", () => {
    expect(isDraining()).toBe(false);
  });

  it("reports 503 while draining even though all dependencies are healthy", async () => {
    const server = buildServer(freshDeps);
    beginDrain();

    const res = await server.inject({ method: "GET", url: "/v1/ready" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    // Dependencies are still reported so an operator can tell a planned drain
    // from a genuine outage.
    expect(body.dependencies.database.status).toBe("ok");
    expect(body.dependencies.indexFreshness.status).toBe("ok");
  });

  it("labels the response as draining", async () => {
    const server = buildServer(freshDeps);
    beginDrain();

    const body = (
      await server.inject({ method: "GET", url: "/v1/ready" })
    ).json();
    expect(body.reason).toBe("draining");
  });

  it("omits the reason when not draining", async () => {
    const server = buildServer(freshDeps);

    const body = (
      await server.inject({ method: "GET", url: "/v1/ready" })
    ).json();
    expect(body.reason).toBeUndefined();
  });

  it("transitions from ready to not-ready as soon as the drain starts", async () => {
    const server = buildServer(freshDeps);

    const before = await server.inject({ method: "GET", url: "/v1/ready" });
    expect(before.statusCode).toBe(200);

    beginDrain();

    const after = await server.inject({ method: "GET", url: "/v1/ready" });
    expect(after.statusCode).toBe(503);
  });

  it("is idempotent so a repeated signal cannot restart the sequence", () => {
    beginDrain();
    beginDrain();
    expect(isDraining()).toBe(true);
  });
});
