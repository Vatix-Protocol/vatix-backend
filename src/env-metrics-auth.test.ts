/**
 * Boot-time authz gate for GET /metrics (#1130).
 *
 * `/metrics` is excluded from the global rate limiter and admission control,
 * so production must not start without an explicit scrape authorization
 * policy (bearer token and/or IP allowlist) — otherwise the endpoint is
 * reachable by anyone who can reach the pod. Dev/test keep the historical
 * open behaviour so local scraping keeps working.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { parseApiEnv } from "./env.js";

const BASE_ENV = {
  DATABASE_URL: "postgresql://vatix:vatix@localhost:5432/vatix",
};

afterEach(() => vi.restoreAllMocks());

describe("parseApiEnv — metrics scrape authz (#1130)", () => {
  it("keeps /metrics open in development/test when nothing is configured", () => {
    const parsed = parseApiEnv({ ...BASE_ENV, NODE_ENV: "test" });
    expect(parsed.METRICS_SCRAPE_TOKEN).toBeUndefined();
    expect(parsed.METRICS_REQUIRE_AUTH).toBeUndefined();
  });

  it("fails closed in production without a token or allowlist", () => {
    expect(() => parseApiEnv({ ...BASE_ENV, NODE_ENV: "production" })).toThrow(
      /GET \/metrics must be restricted/
    );
  });

  it("boots in production with a scrape token", () => {
    const parsed = parseApiEnv({
      ...BASE_ENV,
      NODE_ENV: "production",
      METRICS_SCRAPE_TOKEN: "scrape-token",
    });
    expect(parsed.METRICS_SCRAPE_TOKEN).toBe("scrape-token");
  });

  it("boots in production with an IP allowlist", () => {
    const parsed = parseApiEnv({
      ...BASE_ENV,
      NODE_ENV: "production",
      METRICS_SCRAPE_ALLOWED_IPS: "10.0.0.0/8",
    });
    expect(parsed.METRICS_SCRAPE_ALLOWED_IPS).toBe("10.0.0.0/8");
  });

  it("allows a documented production opt-out, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parsed = parseApiEnv({
      ...BASE_ENV,
      NODE_ENV: "production",
      METRICS_REQUIRE_AUTH: "false",
    });
    expect(parsed.METRICS_REQUIRE_AUTH).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("GET /metrics is unauthenticated in production")
    );
  });

  it("rejects a non-boolean METRICS_REQUIRE_AUTH value", () => {
    expect(() =>
      parseApiEnv({
        ...BASE_ENV,
        NODE_ENV: "test",
        METRICS_REQUIRE_AUTH: "maybe",
      })
    ).toThrow(/METRICS_REQUIRE_AUTH/);
  });
});
