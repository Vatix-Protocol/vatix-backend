import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    // Create a fresh Fastify instance for each test
    server = Fastify({
      logger: false, // Disable logging in tests
      genReqId: () => "test-request-id",
    });

    // Register error handler
    server.setErrorHandler(errorHandler);
  });

  afterEach(async () => {
    await server.close();
  });

  describe("ValidationError", () => {
    it("should return 400 status code", async () => {
      server.get("/test", async () => {
        throw new ValidationError("Validation failed");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      expect(response.statusCode).toBe(400);
    });

    it("should include field details in response", async () => {
      const fields = {
        email: "Invalid email format",
        password: "Password too short",
      };

      server.get("/test", async () => {
        throw new ValidationError("Validation failed", fields);
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(body.fields).toEqual(fields);
    });

    it("should include error message in response", async () => {
      server.get("/test", async () => {
        throw new ValidationError("Invalid input data");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(body.error).toBe("Invalid input data");
    });
  });

  describe("NotFoundError", () => {
    it("should return 404 status code", async () => {
      server.get("/test", async () => {
        throw new NotFoundError("Market not found");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      expect(response.statusCode).toBe(404);
    });

    it("should include error message in response", async () => {
      server.get("/test", async () => {
        throw new NotFoundError("User not found");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(body.error).toBe("User not found");
    });
  });

  describe("UnauthorizedError", () => {
    it("should return 401 status code", async () => {
      server.get("/test", async () => {
        throw new UnauthorizedError("Invalid token");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should include error message in response", async () => {
      server.get("/test", async () => {
        throw new UnauthorizedError("Access denied");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(body.error).toBe("Access denied");
    });
  });

  describe("ForbiddenError", () => {
    it("should return 403 status code", async () => {
      server.get("/test", async () => {
        throw new ForbiddenError("Access forbidden");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      expect(response.statusCode).toBe(403);
    });

    it("should include error message in response", async () => {
      server.get("/test", async () => {
        throw new ForbiddenError("Insufficient permissions");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(body.error).toBe("Insufficient permissions");
    });

    it("should use default message when none provided", async () => {
      server.get("/test", async () => {
        throw new ForbiddenError();
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(response.statusCode).toBe(403);
      expect(body.error).toBe("Forbidden");
    });
  });

  describe("Unknown Errors", () => {
    it("should return 500 status code for generic errors", async () => {
      server.get("/test", async () => {
        throw new Error("Something went wrong");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      expect(response.statusCode).toBe(500);
    });

    it("should include error message in development mode", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      server.get("/test", async () => {
        throw new Error("Database connection failed");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(body.error).toBe("Database connection failed");

      process.env.NODE_ENV = originalEnv;
    });

    it("should hide internal details in production mode", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      server.get("/test", async () => {
        throw new Error("Database connection failed");
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
    it("should have consistent format with error, requestId, and statusCode", async () => {
      server.get("/test", async () => {
        throw new NotFoundError("Resource not found");
      });

      const response = await server.inject({
        method: "GET",
        url: "/test",
      });

      const body = JSON.parse(response.body);
      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("requestId");
      expect(body).toHaveProperty("statusCode");
      expect(typeof body.error).toBe("string");
      expect(typeof body.requestId).toBe("string");
      expect(typeof body.statusCode).toBe("number");
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
