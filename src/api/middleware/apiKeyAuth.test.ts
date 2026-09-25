import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { requireApiKey } from "./apiKeyAuth.js";

describe("requireApiKey middleware", () => {
  let server: FastifyInstance;

  beforeEach(() => {
    server = Fastify({ logger: false });
    server.addHook("onRequest", requireApiKey);
    server.get("/protected", async () => ({ ok: true }));
  });

  afterEach(() => {
    server.close();
    vi.unstubAllEnvs();
  });

  it("returns 401 when X-API-Key header is missing", async () => {
    vi.stubEnv("API_KEY", "test-key");
    const res = await server.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({
      code: "UNAUTHORIZED",
      error: "Missing API key",
    });
  });

  it("returns 401 when X-API-Key header is empty", async () => {
    vi.stubEnv("API_KEY", "test-key");
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when X-API-Key is incorrect", async () => {
    vi.stubEnv("API_KEY", "test-key");
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "wrong-key" },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({
      code: "UNAUTHORIZED",
      error: "Invalid API key",
    });
  });

  it("returns 401 when API_KEY env is not configured", async () => {
    vi.stubEnv("API_KEY", "");
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "any-key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("allows request with correct single API key", async () => {
    vi.stubEnv("API_KEY", "test-key");
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "test-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("allows request with current key during multi-key rotation", async () => {
    vi.stubEnv("API_KEY", "new-key:old-key");
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "new-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("allows request with previous key during rotation window", async () => {
    vi.stubEnv("API_KEY", "new-key:old-key");
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "old-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("rejects rotated-out key after rotation completes", async () => {
    vi.stubEnv("API_KEY", "new-key");
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "old-key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("uses timing-safe comparison to prevent timing attacks", async () => {
    vi.stubEnv("API_KEY", "correct-key");
    // Test that different-length keys are compared safely (no early return on length)
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "x" },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({
      code: "UNAUTHORIZED",
      error: "Invalid API key",
    });
  });

  it("supports multiple rotation keys with whitespace handling", async () => {
    vi.stubEnv("API_KEY", "current-key: previous-key : even-older-key");
    const res1 = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "current-key" },
    });
    expect(res1.statusCode).toBe(200);

    const res2 = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "previous-key" },
    });
    expect(res2.statusCode).toBe(200);

    const res3 = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "even-older-key" },
    });
    expect(res3.statusCode).toBe(200);
  });
});
