import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";
import { registerDeprecatedAliases } from "./legacy.js";

describe("Legacy alias redirects", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    app = fastify({ logger: false });
    registerDeprecatedAliases(app);
    await app.ready();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  it("redirects /health to /v1/health with deprecation headers", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(308);
    expect(response.headers.location).toBe("/v1/health");
    expect(response.headers.deprecation).toBe("true");
    expect(response.headers.sunset).toBe("2026-09-27T00:00:00Z");
    expect(response.headers.link).toBe('</v1/health>; rel="alternate"');
  });

  it("redirects /positions/user/:address to /v1/wallets/:wallet/positions", async () => {
    const address =
      "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const response = await app.inject({
      method: "GET",
      url: `/positions/user/${address}`,
    });

    expect(response.statusCode).toBe(308);
    expect(response.headers.location).toBe(`/v1/wallets/${address}/positions`);
  });

  it("preserves query strings when redirecting legacy endpoints", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/markets/123/orderbook?depth=10&page=2",
    });

    expect(response.statusCode).toBe(308);
    expect(response.headers.location).toBe(
      "/v1/markets/123/orderbook?depth=10&page=2"
    );
  });

  it("returns 404 for legacy aliases after the sunset date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T00:00:00Z"));

    const response = await app.inject({ method: "GET", url: "/markets" });

    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
  });
});
