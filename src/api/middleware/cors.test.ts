import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyCorsOptions } from "@fastify/cors";

// Re-implement getAllowedOrigins logic extracted for unit testing
// This mirrors the implementation in cors.ts exactly.
function getAllowedOrigins(env: Record<string, string | undefined>): string[] {
  const raw = env.CORS_ALLOWED_ORIGINS;
  const isProduction = env.NODE_ENV === "production";

  if (raw && raw.trim() !== "") {
    const origins = raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);

    if (isProduction) {
      const insecure = origins.filter((o) => !o.startsWith("https://"));
      if (insecure.length > 0) {
        throw new Error(
          `CORS misconfiguration: all origins must use https:// in production. ` +
            `Insecure origin(s): ${insecure.join(", ")}`
        );
      }
    }

    return origins;
  }

  if (isProduction) {
    return [];
  }

  return ["http://localhost:3000", "http://localhost:5173"];
}

describe("getAllowedOrigins", () => {
  it("returns defaults for development when CORS_ALLOWED_ORIGINS is unset", () => {
    const origins = getAllowedOrigins({ NODE_ENV: "development" });
    expect(origins).toContain("http://localhost:3000");
    expect(origins).toContain("http://localhost:5173");
  });

  it("returns empty array for production when CORS_ALLOWED_ORIGINS is unset", () => {
    const origins = getAllowedOrigins({ NODE_ENV: "production" });
    expect(origins).toEqual([]);
  });

  it("parses comma-separated CORS_ALLOWED_ORIGINS in development", () => {
    const origins = getAllowedOrigins({
      NODE_ENV: "development",
      CORS_ALLOWED_ORIGINS: "http://localhost:4000,http://localhost:5000",
    });
    expect(origins).toEqual(["http://localhost:4000", "http://localhost:5000"]);
  });

  it("accepts https origins in production", () => {
    const origins = getAllowedOrigins({
      NODE_ENV: "production",
      CORS_ALLOWED_ORIGINS: "https://app.vatix.io,https://staging.vatix.io",
    });
    expect(origins).toEqual([
      "https://app.vatix.io",
      "https://staging.vatix.io",
    ]);
  });

  it("trims whitespace from origins", () => {
    const origins = getAllowedOrigins({
      NODE_ENV: "development",
      CORS_ALLOWED_ORIGINS: " http://localhost:4000 , http://localhost:5000 ",
    });
    expect(origins).toEqual(["http://localhost:4000", "http://localhost:5000"]);
  });

  it("filters out empty entries from CORS_ALLOWED_ORIGINS", () => {
    const origins = getAllowedOrigins({
      NODE_ENV: "development",
      CORS_ALLOWED_ORIGINS: "http://localhost:4000,,http://localhost:5000",
    });
    expect(origins).toEqual(["http://localhost:4000", "http://localhost:5000"]);
  });

  describe("production https enforcement", () => {
    it("throws when an http origin is configured in production", () => {
      expect(() =>
        getAllowedOrigins({
          NODE_ENV: "production",
          CORS_ALLOWED_ORIGINS: "http://app.vatix.io",
        })
      ).toThrow(/https:\/\/ in production/);
    });

    it("throws when a mix of http and https origins is configured in production", () => {
      expect(() =>
        getAllowedOrigins({
          NODE_ENV: "production",
          CORS_ALLOWED_ORIGINS: "https://app.vatix.io,http://legacy.vatix.io",
        })
      ).toThrow(/http:\/\/legacy\.vatix\.io/);
    });

    it("throws for a bare-domain origin (no scheme) in production", () => {
      expect(() =>
        getAllowedOrigins({
          NODE_ENV: "production",
          CORS_ALLOWED_ORIGINS: "app.vatix.io",
        })
      ).toThrow(/https:\/\/ in production/);
    });

    it("does NOT throw for http origins in development", () => {
      expect(() =>
        getAllowedOrigins({
          NODE_ENV: "development",
          CORS_ALLOWED_ORIGINS: "http://app.vatix.io",
        })
      ).not.toThrow();
    });
  });
});

describe("corsPlugin integration", () => {
  let server: FastifyInstance;

  afterEach(async () => {
    await server?.close();
    vi.unstubAllEnvs();
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
});
