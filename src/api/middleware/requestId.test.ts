import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { requestIdMiddleware } from "./requestId.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: () => crypto.randomUUID(),
  });
  await app.register(requestIdMiddleware);
  app.get("/ping", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("requestIdMiddleware", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("accepts a valid incoming x-request-id and echoes it back", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { "x-request-id": VALID_UUID },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe(VALID_UUID);
  });

  it("generates a new UUID when x-request-id header is absent", async () => {
    const res = await app.inject({ method: "GET", url: "/ping" });

    expect(res.statusCode).toBe(200);
    const id = res.headers["x-request-id"] as string;
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(id).not.toBe(VALID_UUID);
  });

  it("generates a new UUID when x-request-id is not a valid UUID", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { "x-request-id": "not-a-uuid" },
    });

    expect(res.statusCode).toBe(200);
    const id = res.headers["x-request-id"] as string;
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(id).not.toBe("not-a-uuid");
  });

  it("always returns x-request-id in the response headers", async () => {
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.headers).toHaveProperty("x-request-id");
  });
});
