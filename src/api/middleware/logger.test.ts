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
    server = Fastify({ genReqId: () => "test-request-id" });
    server.log.info = mockLogInfo;
    server.log.warn = mockLogWarn;
    server.log.error = mockLogError;
    await server.register(requestLogger);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await server.close();
  });

  it("emits one request log and one response log per request", async () => {
    server.get("/test", async () => ({ ok: true }));
    await server.inject({ method: "GET", url: "/test" });

    const requestLogs = mockLogInfo.mock.calls.filter(
      (c) => c[0]?.type === "request"
    );
    const responseLogs = mockLogInfo.mock.calls.filter(
      (c) => c[0]?.type === "response"
    );
    expect(requestLogs).toHaveLength(1);
    expect(responseLogs).toHaveLength(1);
  });

  it("sets X-Request-ID response header", async () => {
    server.get("/test", async () => ({ ok: true }));
    const response = await server.inject({ method: "GET", url: "/test" });
    expect(response.headers["x-request-id"]).toBe("test-request-id");
  });

  it("request log contains requestId, method, and path — no body or sensitive headers", async () => {
    server.get("/test", async () => ({ ok: true }));
    await server.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer secret", cookie: "session=abc" },
    });

    const log = mockLogInfo.mock.calls.find((c) => c[0]?.type === "request");
    expect(log).toBeDefined();
    expect(log![0]).toMatchObject({
      type: "request",
      requestId: "test-request-id",
      method: "GET",
      path: "/test",
    });
    // Sensitive headers must not appear
    expect(JSON.stringify(log![0])).not.toContain("secret");
    expect(JSON.stringify(log![0])).not.toContain("session");
    // Body must not appear
    expect(log![0]).not.toHaveProperty("body");
  });

  it("response log contains requestId, statusCode, and numeric durationMs", async () => {
    server.get("/test", async () => ({ ok: true }));
    await server.inject({ method: "GET", url: "/test" });

    const log = mockLogInfo.mock.calls.find((c) => c[0]?.type === "response");
    expect(log).toBeDefined();
    expect(log![0]).toMatchObject({
      type: "response",
      requestId: "test-request-id",
      method: "GET",
      path: "/test",
      statusCode: 200,
    });
    // durationMs must be a number (machine-parseable)
    expect(typeof log![0].durationMs).toBe("number");
  });

  it("uses warn level for 4xx responses", async () => {
    server.get("/not-found", async (_, reply) => {
      reply.code(404).send({ error: "Not Found" });
    });
    await server.inject({ method: "GET", url: "/not-found" });

    const log = mockLogWarn.mock.calls.find((c) => c[0]?.type === "response");
    expect(log).toBeDefined();
    expect(log![0].statusCode).toBe(404);
  });

  it("uses error level for 5xx responses", async () => {
    server.get("/boom", async () => {
      throw new Error("Server Error");
    });
    await server.inject({ method: "GET", url: "/boom" });

    const log = mockLogError.mock.calls.find((c) => c[0]?.type === "response");
    expect(log).toBeDefined();
    expect(log![0].statusCode).toBe(500);
  });

  it("includes userAddress from route params when present", async () => {
    server.get("/user/:address", async () => ({ ok: true }));
    await server.inject({ method: "GET", url: "/user/GABC123" });

    const log = mockLogInfo.mock.calls.find((c) => c[0]?.type === "request");
    expect(log![0].userAddress).toBe("GABC123");
  });

  it("includes userAddress from x-user-address header when present", async () => {
    server.get("/test", async () => ({ ok: true }));
    await server.inject({
      method: "GET",
      url: "/test",
      headers: { "x-user-address": "GDEF456" },
    });

    const log = mockLogInfo.mock.calls.find((c) => c[0]?.type === "request");
    expect(log![0].userAddress).toBe("GDEF456");
  });

  it("honours X-Correlation-ID as the request ID when genReqId uses it", async () => {
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
      headers: { "x-correlation-id": correlationId },
    });
    expect(response.headers["x-request-id"]).toBe(correlationId);
    await customServer.close();
  });
});
