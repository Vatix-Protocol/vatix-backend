import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { errorHandler } from "./errorHandler.js";
import {
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
} from "./errors.js";

describe("Error Handler Middleware", () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    server = Fastify({ logger: false, genReqId: () => "test-request-id" });
    server.setErrorHandler(errorHandler);
  });

  afterEach(async () => {
    await server.close();
  });

  // Helper
  const inject = (throw_: () => never) => {
    server.get("/test", async () => { throw_(); });
    return server.inject({ method: "GET", url: "/test" });
  };

  describe("envelope shape", () => {
    it("has code, message, statusCode, requestId", async () => {
      server.get("/test", async () => { throw new NotFoundError("x"); });
      const res = await server.inject({ method: "GET", url: "/test" });
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        code: "not_found",
        message: "x",
        statusCode: 404,
        requestId: "test-request-id",
      });
    });

    it("statusCode in body matches HTTP status", async () => {
      server.get("/test", async () => { throw new NotFoundError(); });
      const res = await server.inject({ method: "GET", url: "/test" });
      const body = JSON.parse(res.body);
      expect(body.statusCode).toBe(res.statusCode);
    });
  });

  describe("ValidationError", () => {
    it("returns 400 with code validation_error", async () => {
      server.get("/test", async () => { throw new ValidationError("bad input"); });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("validation_error");
    });

    it("puts fields inside metadata", async () => {
      const fields = { email: "invalid" };
      server.get("/test", async () => { throw new ValidationError("bad", fields); });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(JSON.parse(res.body).metadata).toEqual({ fields });
    });

    it("omits metadata when no fields", async () => {
      server.get("/test", async () => { throw new ValidationError("bad"); });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(JSON.parse(res.body).metadata).toBeUndefined();
    });
  });

  describe("NotFoundError", () => {
    it("returns 404 with code not_found", async () => {
      server.get("/test", async () => { throw new NotFoundError("gone"); });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe("not_found");
    });
  });

  describe("UnauthorizedError", () => {
    it("returns 401 with code unauthorized", async () => {
      server.get("/test", async () => { throw new UnauthorizedError(); });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).code).toBe("unauthorized");
    });
  });

  describe("ForbiddenError", () => {
    it("returns 403 with code forbidden", async () => {
      server.get("/test", async () => { throw new ForbiddenError(); });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe("forbidden");
    });
  });

  describe("generic Error", () => {
    it("returns 500 with code internal_error", async () => {
      server.get("/test", async () => { throw new Error("boom"); });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).code).toBe("internal_error");
    });

    it("exposes message in development", async () => {
      const orig = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      server.get("/test", async () => { throw new Error("db failed"); });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(JSON.parse(res.body).message).toBe("db failed");
      process.env.NODE_ENV = orig;
    });

    it("hides message in production", async () => {
      const orig = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      server.get("/test", async () => { throw new Error("db failed"); });
      const res = await server.inject({ method: "GET", url: "/test" });
      const body = JSON.parse(res.body);
      expect(body.message).not.toContain("db");
      expect(body.code).toBe("internal_error");
      process.env.NODE_ENV = orig;
    });
  });
});
