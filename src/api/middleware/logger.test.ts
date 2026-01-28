import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import Fastify, { FastifyInstance } from "fastify";
import { requestLogger } from "./logger.js";

describe("Request Logger Middleware", () => {
  let server: FastifyInstance;
  const mockLogInfo = vi.fn();
  const mockLogWarn = vi.fn();
  const mockLogError = vi.fn();

  beforeEach(async () => {
    // Create a fresh Fastify instance for each test
    server = Fastify({
      genReqId: () => "test-request-id",
    });

    // Mock the logger
    server.log.info = mockLogInfo;
    server.log.warn = mockLogWarn;
    server.log.error = mockLogError;

    // Register our middleware
    await server.register(requestLogger);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await server.close();
  });

  it("should log incoming requests and include request ID in response headers", async () => {
    server.get("/test", async () => {
      return { ok: true };
    });

    const response = await server.inject({
      method: "GET",
      url: "/test",
    });

    expect(response.headers["x-request-id"]).toBe("test-request-id");
    expect(mockLogInfo).toHaveBeenCalled();

    const requestLog = mockLogInfo.mock.calls.find(
      (call) => call[0] && call[0].type === "request"
    );
    expect(requestLog).toBeDefined();
    expect(requestLog![0]).toMatchObject({
      method: "GET",
      url: "/test",
    });
  });

  it("should log response details including duration and status code", async () => {
    server.get("/test", async () => {
      return { ok: true };
    });

    await server.inject({
      method: "GET",
      url: "/test",
    });

    const responseLog = mockLogInfo.mock.calls.find(
      (call) => call[0] && call[0].type === "response"
    );
    expect(responseLog).toBeDefined();
    expect(responseLog![0]).toMatchObject({
      method: "GET",
      url: "/test",
      statusCode: 200,
    });
    expect(responseLog![0].duration).toMatch(/\d+\.\d+ms/);
  });

  it("should use warn level for 4xx responses", async () => {
    server.get("/404", async (_, reply) => {
      reply.code(404).send({ error: "Not Found" });
    });

    await server.inject({
      method: "GET",
      url: "/404",
    });

    expect(mockLogWarn).toHaveBeenCalled();
    const responseLog = mockLogWarn.mock.calls.find(
      (call) => call[0] && call[0].type === "response"
    );
    expect(responseLog).toBeDefined();
    expect(responseLog![0].statusCode).toBe(404);
  });

  it("should use error level for 5xx responses", async () => {
    server.get("/500", async () => {
      throw new Error("Server Error");
    });

    // Note: Fastify default error handler will return 500
    await server.inject({
      method: "GET",
      url: "/500",
    });

    expect(mockLogError).toHaveBeenCalled();
    const responseLog = mockLogError.mock.calls.find(
      (call) => call[0] && call[0].type === "response"
    );
    expect(responseLog).toBeDefined();
    expect(responseLog![0].statusCode).toBe(500);
  });
  it("should include user address if provided in params", async () => {
    server.get("/user/:address", async () => {
      return { ok: true };
    });

    await server.inject({
      method: "GET",
      url: "/user/GABC123",
    });

    const requestLog = mockLogInfo.mock.calls.find(
      (call) => call[0] && call[0].type === "request"
    );
    expect(requestLog![0].userAddress).toBe("GABC123");
  });

  it("should include user address if provided in headers", async () => {
    server.get("/test", async () => {
      return { ok: true };
    });

    await server.inject({
      method: "GET",
      url: "/test",
      headers: {
        "x-user-address": "GDEF456",
      },
    });

    const requestLog = mockLogInfo.mock.calls.find(
      (call) => call[0] && call[0].type === "request"
    );
    expect(requestLog![0].userAddress).toBe("GDEF456");
  });

  it("should use X-Correlation-ID as request ID if provided", async () => {
    const correlationId = "corr-123";
    const customServer = Fastify({
      genReqId: (req) =>
        (req.headers["x-correlation-id"] as string) || crypto.randomUUID(),
    });

    await customServer.register(requestLogger);
    customServer.get("/test", async () => ({ ok: true }));

    const response = await customServer.inject({
      method: "GET",
      url: "/test",
      headers: {
        "x-correlation-id": correlationId,
      },
    });
    expect(response.headers["x-request-id"]).toBe(correlationId);
    await customServer.close();
  });
});
