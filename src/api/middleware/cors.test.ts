import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyCorsOptions } from "@fastify/cors";
import { resolveCorsAllowedOrigins } from "../../../packages/shared/src/cors.js";

// ---------------------------------------------------------------------------
// resolveCorsAllowedOrigins unit tests (shared helper)
// ---------------------------------------------------------------------------

describe("resolveCorsAllowedOrigins", () => {
  it("returns defaults for development when CORS_ALLOWED_ORIGINS is unset", () => {
    const origins = resolveCorsAllowedOrigins("development", undefined);
    expect(origins).toContain("http://localhost:3000");
    expect(origins).toContain("http://localhost:5173");
  });

  it("returns empty array for production when CORS_ALLOWED_ORIGINS is unset", () => {
    const origins = resolveCorsAllowedOrigins("production", undefined);
    expect(origins).toEqual([]);
  });

  it("parses comma-separated CORS_ALLOWED_ORIGINS in development", () => {
    const origins = resolveCorsAllowedOrigins(
      "development",
      "http://localhost:4000,http://localhost:5000"
    );
    expect(origins).toEqual(["http://localhost:4000", "http://localhost:5000"]);
  });

  it("accepts https origins in production", () => {
    const origins = resolveCorsAllowedOrigins(
      "production",
      "https://app.vatix.io,https://staging.vatix.io"
    );
    expect(origins).toEqual([
      "https://app.vatix.io",
      "https://staging.vatix.io",
    ]);
  });

  it("trims whitespace from origins", () => {
    const origins = resolveCorsAllowedOrigins(
      "development",
      " http://localhost:4000 , http://localhost:5000 "
    );
    expect(origins).toEqual(["http://localhost:4000", "http://localhost:5000"]);
  });

  it("filters out empty entries from CORS_ALLOWED_ORIGINS", () => {
    const origins = resolveCorsAllowedOrigins(
      "development",
      "http://localhost:4000,,http://localhost:5000"
    );
    expect(origins).toEqual(["http://localhost:4000", "http://localhost:5000"]);
  });

  describe("production https enforcement", () => {
    it("throws when an http origin is configured in production", () => {
      expect(() =>
        resolveCorsAllowedOrigins("production", "http://app.vatix.io")
      ).toThrow(/https:\/\/ in production/);
    });

    it("throws when a mix of http and https origins is configured in production", () => {
      expect(() =>
        resolveCorsAllowedOrigins(
          "production",
          "https://app.vatix.io,http://legacy.vatix.io"
        )
      ).toThrow(/http:\/\/legacy\.vatix\.io/);
    });

    it("throws for a bare-domain origin (no scheme) in production", () => {
      expect(() =>
        resolveCorsAllowedOrigins("production", "app.vatix.io")
      ).toThrow(/https:\/\/ in production/);
    });

    it("does NOT throw for http origins in development", () => {
      expect(() =>
        resolveCorsAllowedOrigins("development", "http://app.vatix.io")
      ).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// corsPlugin integration tests
// ---------------------------------------------------------------------------

describe("corsPlugin integration", () => {
  let server: FastifyInstance;

  afterEach(async () => {
    await server?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("allows a request from a configured origin", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "http://localhost:4000");

    const { corsPlugin } = await import("./cors.js");
    server = Fastify({ logger: false });
    await server.register(corsPlugin);
    server.get("/test", async () => ({ ok: true }));

    const res = await server.inject({
      method: "GET",
      url: "/test",
      headers: { origin: "http://localhost:4000" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:4000"
    );
  });

  it("rejects a request from a non-configured origin", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "http://localhost:4000");

    const { corsPlugin } = await import("./cors.js");
    server = Fastify({ logger: false });
    await server.register(corsPlugin);
    server.get("/test", async () => ({ ok: true }));

    const res = await server.inject({
      method: "GET",
      url: "/test",
      headers: { origin: "http://evil.example.com" },
    });
    // Fastify returns 500 when the CORS callback passes an error
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("allows same-origin requests (no Origin header)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "http://localhost:4000");

    const { corsPlugin } = await import("./cors.js");
    server = Fastify({ logger: false });
    await server.register(corsPlugin);
    server.get("/test", async () => ({ ok: true }));

    const res = await server.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
  });

  it("throws at plugin registration when NODE_ENV=production and CORS_ALLOWED_ORIGINS is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "");

    const { corsPlugin } = await import("./cors.js");
    server = Fastify({ logger: false });

    await expect(server.register(corsPlugin)).rejects.toThrow(
      /CORS_ALLOWED_ORIGINS must be set in production/
    );
  });

  it("throws at plugin registration when NODE_ENV=production and an http origin is given", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "http://app.vatix.io");

    const { corsPlugin } = await import("./cors.js");
    server = Fastify({ logger: false });

    await expect(server.register(corsPlugin)).rejects.toThrow(
      /https:\/\/ in production/
    );
  });

  it("allows credentialed requests from whitelisted https origins in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "https://app.vatix.io");

    const { corsPlugin } = await import("./cors.js");
    server = Fastify({ logger: false });
    await server.register(corsPlugin);
    server.get("/test", async () => ({ ok: true }));

    const res = await server.inject({
      method: "GET",
      url: "/test",
      headers: { origin: "https://app.vatix.io" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.vatix.io");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});
