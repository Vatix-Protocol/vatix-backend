/**
 * Unit tests for /metrics scrape authorization (#1130).
 *
 * The endpoint is excluded from the rate limiter and admission control, so
 * these auth negatives are the primary guard against exposing metrics to
 * untrusted clients: no token, wrong token, wrong source address, and the
 * deny-by-default "no authz configured" case.
 */
import { describe, it, expect } from "vitest";
import {
  authorizeMetricsScrape,
  ipMatchesAllowlist,
  loadMetricsScrapePolicy,
  type MetricsScrapePolicy,
} from "./metricsAuth.js";

const TOKEN_POLICY: MetricsScrapePolicy = {
  token: "s3cret-token",
  allowedIps: [],
  requireAuth: true,
};

describe("loadMetricsScrapePolicy", () => {
  it("is deny-by-default in production when nothing is configured", () => {
    expect(loadMetricsScrapePolicy({ NODE_ENV: "production" })).toEqual({
      token: null,
      allowedIps: [],
      requireAuth: true,
    });
  });

  it("stays open in development/test unless authz is configured", () => {
    expect(loadMetricsScrapePolicy({ NODE_ENV: "test" }).requireAuth).toBe(
      false
    );
  });

  it("parses a token and a comma-separated IP allowlist", () => {
    expect(
      loadMetricsScrapePolicy({
        NODE_ENV: "production",
        METRICS_SCRAPE_TOKEN: " tok ",
        METRICS_SCRAPE_ALLOWED_IPS: "10.0.0.0/8, 192.168.1.10 ,",
      })
    ).toEqual({
      token: "tok",
      allowedIps: ["10.0.0.0/8", "192.168.1.10"],
      requireAuth: true,
    });
  });

  it("honours an explicit METRICS_REQUIRE_AUTH=false opt-out", () => {
    expect(
      loadMetricsScrapePolicy({
        NODE_ENV: "production",
        METRICS_REQUIRE_AUTH: "false",
      }).requireAuth
    ).toBe(false);
  });
});

describe("authorizeMetricsScrape — token policy", () => {
  it("allows a request presenting the configured bearer token", () => {
    expect(
      authorizeMetricsScrape(
        { authorization: "Bearer s3cret-token" },
        TOKEN_POLICY
      )
    ).toEqual({ allowed: true });
  });

  it("rejects a request with no Authorization header", () => {
    const decision = authorizeMetricsScrape({}, TOKEN_POLICY);
    expect(decision).toMatchObject({
      allowed: false,
      reason: "missing_token",
      statusCode: 401,
      code: "METRICS_AUTH_MISSING",
    });
  });

  it("rejects a non-bearer Authorization scheme", () => {
    const decision = authorizeMetricsScrape(
      { authorization: "Basic s3cret-token" },
      TOKEN_POLICY
    );
    expect(decision).toMatchObject({ allowed: false, reason: "missing_token" });
  });

  it("rejects a wrong token without echoing it", () => {
    const decision = authorizeMetricsScrape(
      { authorization: "Bearer wrong-token" },
      TOKEN_POLICY
    );
    expect(decision).toMatchObject({
      allowed: false,
      reason: "invalid_token",
      statusCode: 401,
      code: "METRICS_AUTH_INVALID",
    });
    expect(JSON.stringify(decision)).not.toContain("wrong-token");
  });

  it("rejects a token of a different length (no timing short-circuit)", () => {
    const decision = authorizeMetricsScrape(
      { authorization: "Bearer s3cret-token-longer" },
      TOKEN_POLICY
    );
    expect(decision).toMatchObject({ allowed: false, reason: "invalid_token" });
  });

  it("takes precedence over an allowed source address", () => {
    const decision = authorizeMetricsScrape(
      { remoteAddress: "10.0.0.5" },
      { ...TOKEN_POLICY, allowedIps: ["10.0.0.0/8"] }
    );
    expect(decision).toMatchObject({ allowed: false, reason: "missing_token" });
  });
});

describe("authorizeMetricsScrape — IP allowlist policy", () => {
  const ipPolicy: MetricsScrapePolicy = {
    token: null,
    allowedIps: ["10.0.0.0/8", "127.0.0.1"],
    requireAuth: true,
  };

  it("allows an exact match and an in-range address", () => {
    expect(
      authorizeMetricsScrape({ remoteAddress: "127.0.0.1" }, ipPolicy)
    ).toEqual({ allowed: true });
    expect(
      authorizeMetricsScrape({ remoteAddress: "10.42.7.9" }, ipPolicy)
    ).toEqual({ allowed: true });
  });

  it("normalizes IPv4-mapped IPv6 addresses", () => {
    expect(
      authorizeMetricsScrape({ remoteAddress: "::ffff:10.0.0.7" }, ipPolicy)
    ).toEqual({ allowed: true });
  });

  it("rejects an out-of-range address with 403", () => {
    expect(
      authorizeMetricsScrape({ remoteAddress: "192.168.1.5" }, ipPolicy)
    ).toMatchObject({
      allowed: false,
      reason: "ip_not_allowed",
      statusCode: 403,
      code: "METRICS_IP_FORBIDDEN",
    });
  });

  it("rejects a request with no source address", () => {
    expect(authorizeMetricsScrape({}, ipPolicy)).toMatchObject({
      allowed: false,
      reason: "ip_not_allowed",
    });
  });

  it("matches CIDR ranges only when the prefix is valid", () => {
    expect(ipMatchesAllowlist("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipMatchesAllowlist("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
    expect(ipMatchesAllowlist("10.1.2.3", ["10.0.0.0/33"])).toBe(false);
    expect(ipMatchesAllowlist("10.1.2.3", ["not-an-ip"])).toBe(false);
  });
});

describe("authorizeMetricsScrape — deny-by-default", () => {
  it("denies when authz is required but nothing is configured", () => {
    expect(
      authorizeMetricsScrape(
        { remoteAddress: "10.0.0.5" },
        { token: null, allowedIps: [], requireAuth: true }
      )
    ).toMatchObject({
      allowed: false,
      reason: "auth_not_configured",
      statusCode: 403,
      code: "METRICS_AUTH_NOT_CONFIGURED",
    });
  });

  it("allows the historical open scrape in dev/test", () => {
    expect(
      authorizeMetricsScrape(
        { remoteAddress: "203.0.113.9" },
        { token: null, allowedIps: [], requireAuth: false }
      )
    ).toEqual({ allowed: true });
  });
});
