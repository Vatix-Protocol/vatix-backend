import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { makeGenReqId, UUID_REGEX, requestIdMiddleware } from "./requestId.js";

// ---------------------------------------------------------------------------
// makeGenReqId — unit tests (no server needed)
// ---------------------------------------------------------------------------

describe("makeGenReqId", () => {
  it("accepts a valid incoming x-request-id and returns it", () => {
    const validId = "550e8400-e29b-41d4-a716-446655440000";
    const gen = makeGenReqId(() => "fallback");
    const req = { headers: { "x-request-id": validId } } as any;
    expect(gen(req)).toBe(validId);
  });

  it("uses the fallback when x-request-id header is absent", () => {
    const gen = makeGenReqId(() => "generated");
    const req = { headers: {} } as any;
    expect(gen(req)).toBe("generated");
  });

  it("uses the fallback when x-request-id is not a valid UUID", () => {
    const gen = makeGenReqId(() => "generated");
    const req = { headers: { "x-request-id": "not-a-uuid" } } as any;
    expect(gen(req)).toBe("generated");
  });

  it("uses the fallback when x-request-id is an array (duplicate header)", () => {
    const gen = makeGenReqId(() => "generated");
    const req = {
      headers: {
        "x-request-id": ["550e8400-e29b-41d4-a716-446655440000", "other"],
      },
    } as any;
    expect(gen(req)).toBe("generated");
  });

  it("uses the default crypto.randomUUID fallback when none is supplied", () => {
    const gen = makeGenReqId();
    const req = { headers: {} } as any;
    const id = gen(req);
    expect(id).toMatch(UUID_REGEX);
  });
});

// ---------------------------------------------------------------------------
// UUID_REGEX — exported constant
// ---------------------------------------------------------------------------

describe("UUID_REGEX", () => {
  it("matches a valid lowercase UUID v4", () => {
    expect(UUID_REGEX.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("matches a valid uppercase UUID", () => {
    expect(UUID_REGEX.test("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("rejects a non-UUID string", () => {
    expect(UUID_REGEX.test("not-a-uuid")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(UUID_REGEX.test("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requestIdMiddleware plugin — echoes request.id as x-request-id header
// ---------------------------------------------------------------------------

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

async function buildApp(incomingHeader?: string): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: makeGenReqId(() => "fallback-id"),
  });
  await app.register(requestIdMiddleware);
  app.get("/ping", async (request) => ({ requestId: request.id }));
  await app.ready();
  return app;
}

describe("requestIdMiddleware", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("echoes the resolved request ID as x-request-id response header", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { "x-request-id": VALID_UUID },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe(VALID_UUID);
  });

  it("echoes the generated ID when no valid header is provided", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe("fallback-id");
  });

  it("echoes a generated UUID when the incoming header is invalid", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { "x-request-id": "not-a-uuid" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe("fallback-id");
    expect(res.headers["x-request-id"]).not.toBe("not-a-uuid");
  });

  it("always returns x-request-id in the response headers", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.headers).toHaveProperty("x-request-id");
  });

  it("keeps generated request IDs isolated per request", async () => {
    let counter = 0;
    const isolatedApp = Fastify({
      logger: false,
      genReqId: () => `req-${++counter}`,
    });
    await isolatedApp.register(requestIdMiddleware);
    isolatedApp.get("/ping", async (req) => ({ requestId: req.id }));
    await isolatedApp.ready();

    const first = await isolatedApp.inject({ method: "GET", url: "/ping" });
    const second = await isolatedApp.inject({ method: "GET", url: "/ping" });

    expect(first.headers["x-request-id"]).toBe("req-1");
    expect(second.headers["x-request-id"]).toBe("req-2");
    expect(first.headers["x-request-id"]).not.toBe(
      second.headers["x-request-id"]
    );

    await isolatedApp.close();
  });
});
