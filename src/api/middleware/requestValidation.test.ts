import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { errorHandler } from "./errorHandler.js";

describe("Request Input Validation", () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    server = Fastify({ logger: false });
    server.setErrorHandler(errorHandler);

    // Test endpoint with schema validation
    server.get<{ Querystring: { status: string; limit: number } }>(
      "/test",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              status: {
                type: "string",
                enum: ["ACTIVE", "RESOLVED", "CANCELLED"],
              },
              limit: {
                type: "integer",
                minimum: 1,
                maximum: 100,
              },
            },
          },
        },
      },
      async (request) => {
        return { query: request.query };
      }
    );

    // POST endpoint with body validation
    server.post<{ Body: { email: string; age: number } }>(
      "/users",
      {
        schema: {
          body: {
            type: "object",
            required: ["email", "age"],
            properties: {
              email: {
                type: "string",
                format: "email",
              },
              age: {
                type: "integer",
                minimum: 18,
              },
            },
          },
        },
      },
      async (request) => {
        return { user: request.body };
      }
    );

    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  describe("Query parameter validation", () => {
    it("returns 400 when invalid enum value is provided", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/test?status=INVALID",
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty("code");
      expect(body).toHaveProperty("message");
      expect(body).toHaveProperty("statusCode", 400);
    });

    it("returns 400 when limit exceeds maximum", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/test?limit=150",
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.statusCode).toBe(400);
    });

    it("returns 400 when limit is below minimum", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/test?limit=0",
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.statusCode).toBe(400);
    });

    it("returns 200 with valid query parameters", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/test?status=ACTIVE&limit=50",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.query.status).toBe("ACTIVE");
      expect(body.query.limit).toBe(50);
    });
  });

  describe("Request body validation", () => {
    it("returns 400 when required field is missing", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/users",
        payload: { email: "test@example.com" },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.statusCode).toBe(400);
    });

    it("returns 400 when field value is invalid type", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/users",
        payload: { email: "test@example.com", age: "not-a-number" },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.statusCode).toBe(400);
    });

    it("returns 400 when integer field is below minimum", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/users",
        payload: { email: "test@example.com", age: 15 },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.statusCode).toBe(400);
    });

    it("returns 200 with valid request body", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/users",
        payload: { email: "test@example.com", age: 25 },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.user.email).toBe("test@example.com");
      expect(body.user.age).toBe(25);
    });
  });
});
