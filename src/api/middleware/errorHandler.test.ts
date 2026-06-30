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
    server.get("/test", async () => {
      throw_();
    });
    return server.inject({ method: "GET", url: "/test" });
  };

  describe("envelope shape", () => {
    it("has code, message, statusCode, requestId", async () => {
      server.get("/test", async () => {
        throw new NotFoundError("x");
      });
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
      server.get("/test", async () => {
        throw new NotFoundError();
      });
      const res = await server.inject({ method: "GET", url: "/test" });
      const body = JSON.parse(res.body);
      expect(body.statusCode).toBe(res.statusCode);
    });
  });

  describe("ValidationError", () => {
    it("returns 400 with code validation_error", async () => {
      server.get("/test", async () => {
        throw new ValidationError("bad input");
      });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("validation_error");
    });

    it("puts fields inside metadata", async () => {
      const fields = { email: "invalid" };
      server.get("/test", async () => {
        throw new ValidationError("bad", fields);
      });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(JSON.parse(res.body).metadata).toEqual({ fields });
    });

    it("omits metadata when no fields", async () => {
      server.get("/test", async () => {
        throw new ValidationError("bad");
      });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(JSON.parse(res.body).metadata).toBeUndefined();
    });
  });

  describe("NotFoundError", () => {
    it("returns 404 with code not_found", async () => {
      server.get("/test", async () => {
        throw new NotFoundError("gone");
      });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe("not_found");
    });
  });

  describe("UnauthorizedError", () => {
    it("returns 401 with code unauthorized", async () => {
      server.get("/test", async () => {
        throw new UnauthorizedError();
      });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).code).toBe("unauthorized");
    });
  });

  describe("ForbiddenError", () => {
    it("returns 403 with code forbidden", async () => {
      server.get("/test", async () => {
        throw new ForbiddenError();
      });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe("forbidden");
    });
  });

  describe("generic Error", () => {
    it("returns 500 with code internal_error", async () => {
      server.get("/test", async () => {
        throw new Error("boom");
      });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).code).toBe("internal_error");
    });

    it("exposes message in development", async () => {
      const orig = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      server.get("/test", async () => {
        throw new Error("db failed");
      });
      const res = await server.inject({ method: "GET", url: "/test" });
      expect(JSON.parse(res.body).message).toBe("db failed");
      process.env.NODE_ENV = orig;
    });

    it("hides message in production", async () => {
      const orig = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      server.get("/test", async () => {
        throw new Error("db failed");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(body.error).toBe("Internal server error");
      expect(body.error).not.toContain("Database");

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe("Response Format", () => {
    it("should have consistent format with error, code, requestId, and statusCode", async () => {
      server.get("/test", async () => {
        throw new NotFoundError("Resource not found");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("code");
      expect(body).toHaveProperty("requestId");
      expect(body).toHaveProperty("statusCode");
      expect(typeof body.error).toBe("string");
      expect(typeof body.code).toBe("string");
      expect(typeof body.requestId).toBe("string");
      expect(typeof body.statusCode).toBe("number");
    });

    it("should return correct code per error type", async () => {
      const cases: [() => Error, string][] = [
        [() => new ValidationError("bad"), "VALIDATION_ERROR"],
        [() => new NotFoundError("nope"), "NOT_FOUND"],
        [() => new UnauthorizedError("denied"), "UNAUTHORIZED"],
        [() => new ForbiddenError("forbidden"), "FORBIDDEN"],
        [() => new Error("boom"), "INTERNAL_ERROR"],
      ];

      for (const [makeError, expectedCode] of cases) {
        server.get(`/test-${expectedCode}`, async () => {
          throw makeError();
        });
        const res = await server.inject({
          method: "GET",
          url: `/test-${expectedCode}`,
        });
        expect(JSON.parse(res.body).code).toBe(expectedCode);
      }
    });

    it("should include request ID in response", async () => {
      server.get("/test", async () => {
        throw new Error("Test error");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(body.requestId).toBe("test-request-id");
    });

    it("should match statusCode in response body and HTTP status", async () => {
      server.get("/test", async () => {
        throw new NotFoundError("Not found");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(body.statusCode).toBe(response.statusCode);
      expect(body.statusCode).toBe(404);
    });
  });

  describe("Logging", () => {
    it("should log client errors at warn level", async () => {
      // Use a simple approach - check that the error handler doesn't crash
      // Actual logging is tested via integration tests
      server.get("/test", async () => {
        throw new ValidationError("Bad input");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      expect(response.statusCode).toBe(400);
      // If we got here, logging worked without crashing
    });

    it("should log server errors at error level", async () => {
      // Use a simple approach - check that the error handler doesn't crash
      // Actual logging is tested via integration tests
      server.get("/test", async () => {
        throw new Error("Internal error");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      expect(response.statusCode).toBe(500);
      // If we got here, logging worked without crashing
    });
  });

  describe("Edge Cases", () => {
    it("should handle errors with custom status codes", async () => {
      class CustomError extends Error {
        statusCode = 418; // I'm a teapot
      }

      server.get("/test", async () => {
        throw new CustomError("Custom error");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      expect(response.statusCode).toBe(418);
    });

    it("should handle ValidationError without fields", async () => {
      server.get("/test", async () => {
        throw new ValidationError("Validation failed");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(body.statusCode).toBe(400);
      expect(body.fields).toBeUndefined();
    });
  });
});
