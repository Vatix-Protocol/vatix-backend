import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { unauthorized, forbidden, success } from "./responses.js";

describe("Auth response helpers", () => {
  let server: FastifyInstance;

  beforeEach(() => {
    server = Fastify({ logger: false });
    server.get("/test-401", async (_, reply) => { unauthorized(reply); });
    server.get("/test-401-msg", async (_, reply) => { unauthorized(reply, "Token expired"); });
    server.get("/test-403", async (_, reply) => { forbidden(reply); });
    server.get("/test-403-msg", async (_, reply) => { forbidden(reply, "Admin only"); });
    server.get("/test-200", async (_, reply) => {
      success(reply, { message: "ok" });
    });
  });

  afterEach(() => server.close());

  it("unauthorized returns 401 with UNAUTHORIZED code", async () => {
    const res = await server.inject({ method: "GET", url: "/test-401" });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(401);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.statusCode).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("unauthorized accepts custom message", async () => {
    const res = await server.inject({ method: "GET", url: "/test-401-msg" });
    expect(JSON.parse(res.body).error).toBe("Token expired");
  });

  it("forbidden returns 403 with FORBIDDEN code", async () => {
    const res = await server.inject({ method: "GET", url: "/test-403" });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
    expect(body.statusCode).toBe(403);
    expect(body.error).toBe("Forbidden");
  });

  it("forbidden accepts custom message", async () => {
    const res = await server.inject({ method: "GET", url: "/test-403-msg" });
    expect(JSON.parse(res.body).error).toBe("Admin only");
  });

  it("401 and 403 are distinct status codes", async () => {
    const r401 = await server.inject({ method: "GET", url: "/test-401" });
    const r403 = await server.inject({ method: "GET", url: "/test-403" });
    expect(r401.statusCode).not.toBe(r403.statusCode);
  });

  it("success helper returns standardized success envelope", async () => {
    const res = await server.inject({ method: "GET", url: "/test-200" });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { message: "ok" },
    });
  });
});
