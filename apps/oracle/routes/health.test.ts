/**
 * Oracle health routes — liveness/readiness split, fail-closed dependency
 * handling, correlation ids and probe authz (#1116).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import {
  healthRoutes,
  runDependencyProbes,
  tokensMatch,
  ORACLE_HEALTH_ERROR_CODES,
  type DependencyProbe,
} from "./health.js";

const okProbe = (name: string): DependencyProbe => ({
  name,
  check: async () => undefined,
});

const failingProbe = (name: string): DependencyProbe => ({
  name,
  check: async () => {
    throw new Error("connect ECONNREFUSED 10.0.0.5:5432 (password=hunter2)");
  },
});

async function buildApp(
  probes: DependencyProbe[],
  extra: { requiredToken?: string; probeTimeoutMs?: number } = {}
): Promise<FastifyInstance> {
  const instance = fastify({ logger: false });
  await instance.register(healthRoutes, { probes, ...extra });
  await instance.ready();
  return instance;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /health — liveness (#1116)", () => {
  it("returns 200 with no dependency access at all", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const app = await buildApp([{ name: "database", check }]);

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("vatix-oracle");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.timestamp).toBe("string");
    expect(check).not.toHaveBeenCalled();

    await app.close();
  });

  it("stays 200 while a dependency is down (a DB blip must not restart the oracle)", async () => {
    const app = await buildApp([failingProbe("database")]);

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("echoes the caller correlation id", async () => {
    const app = await buildApp([okProbe("database")]);

    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-correlation-id": "corr-123" },
    });

    expect(res.json().correlationId).toBe("corr-123");
    await app.close();
  });
});

describe("GET /health/ready — readiness (#1116)", () => {
  it("returns 200 when every dependency is reachable", async () => {
    const app = await buildApp([okProbe("database"), okProbe("redis")]);

    const res = await app.inject({ method: "GET", url: "/health/ready" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      dependencies: { database: "ok", redis: "ok" },
    });
    await app.close();
  });

  it("fails closed with 503 when a dependency is unavailable", async () => {
    const app = await buildApp([okProbe("database"), failingProbe("redis")]);

    const res = await app.inject({ method: "GET", url: "/health/ready" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("degraded");
    expect(body.code).toBe(ORACLE_HEALTH_ERROR_CODES.DEPENDENCY_UNAVAILABLE);
    expect(body.dependencies).toEqual({
      database: "ok",
      redis: "unavailable",
    });
    await app.close();
  });

  it("never leaks dependency error details", async () => {
    const app = await buildApp([failingProbe("database")]);

    const res = await app.inject({ method: "GET", url: "/health/ready" });

    expect(res.body).not.toContain("ECONNREFUSED");
    expect(res.body).not.toContain("10.0.0.5");
    expect(res.body).not.toContain("hunter2");
    await app.close();
  });

  it("times out a hung dependency instead of hanging the probe", async () => {
    const app = await buildApp(
      [{ name: "database", check: () => new Promise(() => {}) }],
      { probeTimeoutMs: 25 }
    );

    const res = await app.inject({ method: "GET", url: "/health/ready" });

    expect(res.statusCode).toBe(503);
    expect(res.json().dependencies.database).toBe("unavailable");
    await app.close();
  });
});

describe("probe authz (#1116)", () => {
  it("rejects a missing or wrong token when one is configured (deny-by-default)", async () => {
    const app = await buildApp([okProbe("database")], {
      requiredToken: "s3cret",
    });

    const missing = await app.inject({ method: "GET", url: "/health/ready" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().code).toBe(ORACLE_HEALTH_ERROR_CODES.UNAUTHORIZED);

    const wrong = await app.inject({
      method: "GET",
      url: "/health/ready",
      headers: { "x-health-token": "nope" },
    });
    expect(wrong.statusCode).toBe(401);

    await app.close();
  });

  it("accepts the configured token", async () => {
    const app = await buildApp([okProbe("database")], {
      requiredToken: "s3cret",
    });

    const res = await app.inject({
      method: "GET",
      url: "/health/ready",
      headers: { "x-health-token": "s3cret" },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("keeps liveness reachable without the token", async () => {
    const app = await buildApp([okProbe("database")], {
      requiredToken: "s3cret",
    });

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("runDependencyProbes (#1116)", () => {
  it("marks every dependency ok when all checks resolve", async () => {
    const results = await runDependencyProbes(
      [okProbe("database"), okProbe("redis")],
      100,
      "corr-1"
    );

    expect(results).toEqual({ database: "ok", redis: "ok" });
  });

  it("fails closed without surfacing the error message", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const results = await runDependencyProbes(
      [failingProbe("redis")],
      100,
      "corr-2",
      logger
    );

    expect(results).toEqual({ redis: "unavailable" });
    expect(logger.warn).toHaveBeenCalledWith(
      { correlationId: "corr-2", dependency: "redis" },
      "Oracle readiness dependency unavailable"
    );
  });
});

describe("tokensMatch (#1116)", () => {
  it("compares without throwing on length mismatch", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "abcdef")).toBe(false);
    expect(tokensMatch(undefined, "abc")).toBe(false);
    expect(tokensMatch(["abc"], "abc")).toBe(false);
  });
});
