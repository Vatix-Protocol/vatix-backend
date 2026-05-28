import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { requestIdMiddleware } from "./requestId.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(requestIdMiddleware);
  app.get("/context", async (request) => ({ requestId: request.id }));
  await app.ready();

  return app;
}

describe("request context", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("attaches the resolved requestId to each request", async () => {
    app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/context",
      headers: { "x-request-id": VALID_UUID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe(VALID_UUID);
    expect(JSON.parse(response.body)).toEqual({ requestId: VALID_UUID });
  });

  it("keeps generated requestIds isolated per request", async () => {
    app = await buildApp();

    const first = await app.inject({ method: "GET", url: "/context" });
    const second = await app.inject({ method: "GET", url: "/context" });
    const firstBody = JSON.parse(first.body) as { requestId: string };
    const secondBody = JSON.parse(second.body) as { requestId: string };

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(firstBody.requestId).toBe(first.headers["x-request-id"]);
    expect(secondBody.requestId).toBe(second.headers["x-request-id"]);
    expect(firstBody.requestId).not.toBe(secondBody.requestId);
  });
});
