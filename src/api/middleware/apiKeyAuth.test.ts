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

  it("allows request with correct API key", async () => {
    vi.stubEnv("API_KEY", "test-key");
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "test-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });
});
