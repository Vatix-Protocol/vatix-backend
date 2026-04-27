import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { rateLimiter } from "./rateLimiter.js";

describe("rateLimiter middleware", () => {
  let server: FastifyInstance;

  beforeEach(() => {
    server = Fastify({ logger: false });
    server.addHook("onRequest", rateLimiter);
    server.get("/test", async () => ({ ok: true }));
  });

  afterEach(() => {
    server.close();
    vi.unstubAllEnvs();
  });

  it("allows requests under the limit", async () => {
    vi.stubEnv("RATE_LIMIT_MAX", "5");
    vi.stubEnv("RATE_LIMIT_WINDOW_MS", "60000");

    const res = await server.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
  });

  it("returns 429 when limit is exceeded", async () => {
    vi.stubEnv("RATE_LIMIT_MAX", "2");
    vi.stubEnv("RATE_LIMIT_WINDOW_MS", "60000");

    // Need a fresh server so env vars are picked up per-request
    // rateLimiter reads env at call time, so we can exhaust via same IP
    const s = Fastify({ logger: false });
    s.addHook("onRequest", rateLimiter);
    s.get("/t", async () => ({ ok: true }));

    await s.inject({ method: "GET", url: "/t" });
    await s.inject({ method: "GET", url: "/t" });
    const res = await s.inject({ method: "GET", url: "/t" });

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retryAfter).toBeGreaterThan(0);
    await s.close();
  });

  it("includes Retry-After header on 429", async () => {
    const s = Fastify({ logger: false });
    s.addHook("onRequest", rateLimiter);
    s.get("/t", async () => ({ ok: true }));

    vi.stubEnv("RATE_LIMIT_MAX", "1");
    await s.inject({ method: "GET", url: "/t" });
    const res = await s.inject({ method: "GET", url: "/t" });

    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    await s.close();
  });
});
