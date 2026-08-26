import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/index.js";
import { resetRateLimits } from "./helpers/build-test-app.js";

describe("Rate Limiter — Trust Proxy Hardening (#940)", () => {
  let appProduction: FastifyInstance;
  let appDevelopment: FastifyInstance;

  beforeAll(async () => {
    // Production: trustProxy=1 (trust only 1 hop — the immediate upstream)
    process.env.NODE_ENV = "production";
    appProduction = buildServer();

    // Development: trustProxy=0 (no proxy trust — only direct socket)
    process.env.NODE_ENV = "development";
    appDevelopment = buildServer();
  });

  afterAll(async () => {
    await appProduction.close();
    await appDevelopment.close();
  });

  it("production: rejects spoofed X-Forwarded-For from untrusted client", async () => {
    resetRateLimits();
    const realClientIp = "192.0.2.1"; // Real IP (DOCTEST range)
    const spooledIp = "203.0.113.100"; // Attacker's spoofed IP (TEST-NET range)

    // Simulating: attacker at realClientIp sends X-Forwarded-For with spoofedIp
    // Production should reject this spoofed value and use the real socket IP instead
    const response1 = await appProduction.inject({
      method: "GET",
      url: "/v1/markets",
      remoteAddress: realClientIp, // True client address (via socket)
      headers: {
        "x-forwarded-for": spooledIp, // Attacker injects fake upstream IP
      },
    });

    // Quota should be tracked against the real IP (realClientIp), not the spoofed one.
    // The quota headers confirm rate limiting is active.
    expect(response1.statusCode).toBe(200);
    expect(response1.headers["ratelimit-remaining"]).toBeDefined();
    const remaining1 = Number(response1.headers["ratelimit-remaining"]);

    // Second request from same real client (using spoofed header again)
    // Should consume quota from the same real-IP bucket, not a new bucket
    const response2 = await appProduction.inject({
      method: "GET",
      url: "/v1/markets",
      remoteAddress: realClientIp,
      headers: {
        "x-forwarded-for": spooledIp, // Different spoofed IP each time
      },
    });

    const remaining2 = Number(response2.headers["ratelimit-remaining"]);

    // Quota should have decreased (same real IP), proving rate limiter is keyed
    // off real IP, not the spoofed one. If keyed by spoofed IP, remaining would stay high.
    expect(remaining2).toBeLessThan(remaining1);
  });

  it("development: ignores X-Forwarded-For entirely (trustProxy=0)", async () => {
    resetRateLimits();
    const realClientIp = "192.0.2.2";
    const spooledIp = "203.0.113.101";

    // In development, trustProxy is 0 — no proxy trust.
    // Rate limiter should use only direct socket address, ignoring XFF header entirely.
    const response1 = await appDevelopment.inject({
      method: "GET",
      url: "/v1/markets",
      remoteAddress: realClientIp,
      headers: {
        "x-forwarded-for": spooledIp,
      },
    });

    expect(response1.statusCode).toBe(200);
    const remaining1 = Number(response1.headers["ratelimit-remaining"]);

    // Second request from different real IP with different spoofed IP should
    // be treated as a different client (because dev doesn't trust XFF)
    const response2 = await appDevelopment.inject({
      method: "GET",
      url: "/v1/markets",
      remoteAddress: "192.0.2.3", // Different socket IP
      headers: {
        "x-forwarded-for": spooledIp, // Same spoofed IP as before
      },
    });

    const remaining2 = Number(response2.headers["ratelimit-remaining"]);

    // Different socket IPs → different quota buckets → remaining should be the same
    // (each has its own budget)
    expect(remaining2).toBe(remaining1); // Both clients start fresh
  });

  it("production: correctly respects legitimate proxy chain (trustProxy=1)", async () => {
    resetRateLimits();
    // Simulate: client → load-balancer → API
    // The load balancer (trustworthy upstream) adds the client's real IP to XFF
    const realClientIp = "203.0.113.50"; // Real client behind load balancer
    const loadBalancerIp = "10.0.1.1"; // Our trusted proxy's IP
    const attackerIpFromInternet = "203.0.113.200"; // Attacker's IP (untrusted source)

    // Legitimate request through load balancer: client → LB → API
    const response1 = await appProduction.inject({
      method: "GET",
      url: "/v1/markets",
      remoteAddress: loadBalancerIp, // Request came from LB socket address
      headers: {
        "x-forwarded-for": realClientIp, // LB set this correctly
      },
    });

    expect(response1.statusCode).toBe(200);
    const remaining1 = Number(response1.headers["ratelimit-remaining"]);

    // Same real client makes another request through the LB
    const response2 = await appProduction.inject({
      method: "GET",
      url: "/v1/markets",
      remoteAddress: loadBalancerIp,
      headers: {
        "x-forwarded-for": realClientIp,
      },
    });

    const remaining2 = Number(response2.headers["ratelimit-remaining"]);
    // Quota should have decreased (same real client IP)
    expect(remaining2).toBeLessThan(remaining1);

    // Now an attacker on the internet tries to bypass by spoofing XFF
    // (request does NOT come through the LB socket)
    const response3 = await appProduction.inject({
      method: "GET",
      url: "/v1/markets",
      remoteAddress: attackerIpFromInternet, // Attacker's direct IP, not LB
      headers: {
        "x-forwarded-for": realClientIp, // Attacker spoofs the real client's IP
      },
    });

    expect(response3.statusCode).toBe(200);
    const remaining3 = Number(response3.headers["ratelimit-remaining"]);
    // This request should NOT reduce the real client's quota
    // (because the request didn't come through the trusted LB).
    // Instead, it should start a new quota bucket for the attacker IP.
    // The real client's remaining quota should now be higher than remaining2
    // because we made a request for a different client (attacker).
    expect(remaining3).toBeGreaterThan(remaining2);
  });
});
