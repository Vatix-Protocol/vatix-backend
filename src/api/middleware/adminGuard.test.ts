import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { requireAdmin } from "./adminGuard.js";

describe("requireAdmin guard", () => {
  let server: FastifyInstance;

  beforeEach(() => {
    server = Fastify({ logger: false });
    server.addHook("onRequest", requireAdmin);
    server.get("/admin/test", async () => ({ ok: true }));
  });

  afterEach(() => {
    server.close();
    vi.unstubAllEnvs();
  });

  it("returns 401 when no Authorization header", async () => {
    vi.stubEnv("ADMIN_TOKEN", "secret");
    const res = await server.inject({ method: "GET", url: "/admin/test" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when header is not Bearer scheme", async () => {
    vi.stubEnv("ADMIN_TOKEN", "secret");
    const res = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when token is wrong", async () => {
    vi.stubEnv("ADMIN_TOKEN", "secret");
    const res = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("FORBIDDEN");
  });

  it("allows request with correct admin token", async () => {
    vi.stubEnv("ADMIN_TOKEN", "secret");
    const res = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Bearer secret" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("returns 403 when ADMIN_TOKEN env is not set", async () => {
    vi.stubEnv("ADMIN_TOKEN", "");
    const res = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Bearer anything" },
    });
    expect(res.statusCode).toBe(403);
  });
});
