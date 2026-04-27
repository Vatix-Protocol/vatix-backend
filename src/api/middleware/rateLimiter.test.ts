import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import {
  rateLimiter,
  heavyReadLimiter,
  writeLimiter,
} from "./rateLimiter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildServer(
  hook: typeof rateLimiter,
  route = "/test"
): FastifyInstance {
  const server = Fastify({ logger: false });
  server.get(route, { onRequest: [hook] }, async () => ({ ok: true }));
  server.post(route, { onRequest: [hook] }, async () => ({ ok: true }));
  return server;
}

async function exhaust(
  server: FastifyInstance,
  n: number,
  method: "GET" | "POST" = "GET",
  url = "/test"
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await server.inject({ method, url });
  }
}

// ---------------------------------------------------------------------------
// Global rate limiter
// ---------------------------------------------------------------------------

describe("rateLimiter (global)", () => {
  let server: FastifyInstance;

  beforeEach(() => {
    vi.stubEnv("RATE_LIMIT_MAX", "5");
    vi.stubEnv("RATE_LIMIT_WINDOW_MS", "60000");
    server = buildServer(rateLimiter);
  });

  afterEach(async () => {
    await server.close();
    vi.unstubAllEnvs();
  });

  it("allows requests under the limit", async () => {
    const res = await server.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
  });

  it("returns 429 when limit is exceeded", async () => {
    const s = Fastify({ logger: false });
    s.get("/t", { onRequest: [rateLimiter] }, async () => ({ ok: true }));

    vi.stubEnv("RATE_LIMIT_MAX", "2");
    vi.stubEnv("RATE_LIMIT_WINDOW_MS", "60000");

    await exhaust(s, 2, "GET", "/t");
    const res = await s.inject({ method: "GET", url: "/t" });

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retryAfter).toBeGreaterThan(0);
    await s.close();
  });

  it("includes Retry-After header on 429", async () => {
    const s = Fastify({ logger: false });
    s.get("/t", { onRequest: [rateLimiter] }, async () => ({ ok: true }));

    vi.stubEnv("RATE_LIMIT_MAX", "1");

    await s.inject({ method: "GET", url: "/t" });
    const res = await s.inject({ method: "GET", url: "/t" });

    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    await s.close();
  });
});

// ---------------------------------------------------------------------------
// Heavy-read rate limiter
// ---------------------------------------------------------------------------

describe("heavyReadLimiter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows requests under the heavy limit", async () => {
    vi.stubEnv("RATE_LIMIT_HEAVY_MAX", "5");
    vi.stubEnv("RATE_LIMIT_HEAVY_WINDOW_MS", "60000");

    const s = buildServer(heavyReadLimiter);
    const res = await s.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    await s.close();
  });

  it("enforces a lower threshold than the global limiter", async () => {
    // Heavy limit set to 3; global would be 100 — heavy fires first.
    vi.stubEnv("RATE_LIMIT_HEAVY_MAX", "3");
    vi.stubEnv("RATE_LIMIT_HEAVY_WINDOW_MS", "60000");
    vi.stubEnv("RATE_LIMIT_MAX", "100");

    const s = Fastify({ logger: false });
    s.get(
      "/markets",
      { onRequest: [heavyReadLimiter] },
      async () => ({ ok: true })
    );

    await exhaust(s, 3, "GET", "/markets");
    const res = await s.inject({ method: "GET", url: "/markets" });

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("RATE_LIMITED");
    await s.close();
  });

  it("returns 429 with Retry-After header", async () => {
    vi.stubEnv("RATE_LIMIT_HEAVY_MAX", "1");
    vi.stubEnv("RATE_LIMIT_HEAVY_WINDOW_MS", "60000");

    const s = buildServer(heavyReadLimiter);
    await s.inject({ method: "GET", url: "/test" });
    const res = await s.inject({ method: "GET", url: "/test" });

    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    await s.close();
  });

  it("uses RATE_LIMIT_HEAVY_MAX env var", async () => {
    vi.stubEnv("RATE_LIMIT_HEAVY_MAX", "2");
    vi.stubEnv("RATE_LIMIT_HEAVY_WINDOW_MS", "60000");

    const s = buildServer(heavyReadLimiter);
    await exhaust(s, 2);
    const res = await s.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(429);
    await s.close();
  });
});

// ---------------------------------------------------------------------------
// Write rate limiter
// ---------------------------------------------------------------------------

describe("writeLimiter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows requests under the write limit", async () => {
    vi.stubEnv("RATE_LIMIT_WRITE_MAX", "5");
    vi.stubEnv("RATE_LIMIT_WRITE_WINDOW_MS", "60000");

    const s = buildServer(writeLimiter);
    const res = await s.inject({ method: "POST", url: "/test" });
    expect(res.statusCode).toBe(200);
    await s.close();
  });

  it("enforces the strictest threshold for write endpoints", async () => {
    vi.stubEnv("RATE_LIMIT_WRITE_MAX", "2");
    vi.stubEnv("RATE_LIMIT_WRITE_WINDOW_MS", "60000");

    const s = Fastify({ logger: false });
    s.post(
      "/orders",
      { onRequest: [writeLimiter] },
      async () => ({ ok: true })
    );

    await exhaust(s, 2, "POST", "/orders");
    const res = await s.inject({ method: "POST", url: "/orders" });

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("RATE_LIMITED");
    await s.close();
  });

  it("returns 429 with Retry-After header on write overflow", async () => {
    vi.stubEnv("RATE_LIMIT_WRITE_MAX", "1");
    vi.stubEnv("RATE_LIMIT_WRITE_WINDOW_MS", "60000");

    const s = buildServer(writeLimiter);
    await s.inject({ method: "POST", url: "/test" });
    const res = await s.inject({ method: "POST", url: "/test" });

    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    await s.close();
  });

  it("uses RATE_LIMIT_WRITE_MAX env var", async () => {
    vi.stubEnv("RATE_LIMIT_WRITE_MAX", "3");
    vi.stubEnv("RATE_LIMIT_WRITE_WINDOW_MS", "60000");

    const s = buildServer(writeLimiter);
    await exhaust(s, 3, "POST");
    const res = await s.inject({ method: "POST", url: "/test" });
    expect(res.statusCode).toBe(429);
    await s.close();
  });
});

// ---------------------------------------------------------------------------
// Tier isolation — heavy and write counters are independent of global
// ---------------------------------------------------------------------------

describe("tier isolation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("heavy-read counter does not affect global counter", async () => {
    vi.stubEnv("RATE_LIMIT_HEAVY_MAX", "1");
    vi.stubEnv("RATE_LIMIT_HEAVY_WINDOW_MS", "60000");
    vi.stubEnv("RATE_LIMIT_MAX", "100");

    const s = Fastify({ logger: false });
    // /heavy uses heavyReadLimiter; /light uses global rateLimiter
    s.get(
      "/heavy",
      { onRequest: [heavyReadLimiter] },
      async () => ({ ok: true })
    );
    s.get("/light", { onRequest: [rateLimiter] }, async () => ({ ok: true }));

    // Exhaust the heavy tier
    await s.inject({ method: "GET", url: "/heavy" });
    const heavyRes = await s.inject({ method: "GET", url: "/heavy" });
    expect(heavyRes.statusCode).toBe(429);

    // Global tier should still be fine
    const lightRes = await s.inject({ method: "GET", url: "/light" });
    expect(lightRes.statusCode).toBe(200);

    await s.close();
  });

  it("write counter does not affect heavy-read counter", async () => {
    vi.stubEnv("RATE_LIMIT_WRITE_MAX", "1");
    vi.stubEnv("RATE_LIMIT_WRITE_WINDOW_MS", "60000");
    vi.stubEnv("RATE_LIMIT_HEAVY_MAX", "10");
    vi.stubEnv("RATE_LIMIT_HEAVY_WINDOW_MS", "60000");

    const s = Fastify({ logger: false });
    s.post(
      "/orders",
      { onRequest: [writeLimiter] },
      async () => ({ ok: true })
    );
    s.get(
      "/markets",
      { onRequest: [heavyReadLimiter] },
      async () => ({ ok: true })
    );

    // Exhaust write tier
    await s.inject({ method: "POST", url: "/orders" });
    const writeRes = await s.inject({ method: "POST", url: "/orders" });
    expect(writeRes.statusCode).toBe(429);

    // Heavy-read tier should still be fine
    const readRes = await s.inject({ method: "GET", url: "/markets" });
    expect(readRes.statusCode).toBe(200);

    await s.close();
  });
});
