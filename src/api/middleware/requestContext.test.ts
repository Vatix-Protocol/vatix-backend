import { describe, it, expect, afterEach } from "vitest";
import { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { makeGenReqId, requestIdMiddleware } from "./requestId.js";
import { requestLogger } from "./logger.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect JSON log lines emitted by a pino logger into an array. */
function captureStream(): {
  logs: Record<string, unknown>[];
  stream: Writable;
} {
  const logs: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      const line = chunk.toString().trim();
      if (line) {
        try {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // non-JSON output (e.g. pino's startup line) — ignore
        }
      }
      cb();
    },
  });
  return { logs, stream };
}

function buildApp(stream: Writable): FastifyInstance {
  const app = Fastify({
    logger: { stream },
    requestIdLogLabel: "requestId",
    genReqId: makeGenReqId(() => "generated-id"),
  });
  app.register(requestIdMiddleware);
  app.register(requestLogger);
  return app;
}

// ---------------------------------------------------------------------------
// Tests — request ID context propagation
// ---------------------------------------------------------------------------

describe("request context", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("attaches the resolved requestId to each request (via response body)", async () => {
    const { stream } = captureStream();
    app = buildApp(stream);
    app.get("/context", async (request) => ({ requestId: request.id }));
    await app.ready();

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
    let counter = 0;
    const { stream } = captureStream();
    app = Fastify({
      logger: { stream },
      requestIdLogLabel: "requestId",
      genReqId: () => `req-${++counter}`,
    });
    app.register(requestIdMiddleware);
    app.get("/context", async (request) => ({ requestId: request.id }));
    await app.ready();

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

  it("propagates requestId to every pino log entry emitted during a request", async () => {
    const { logs, stream } = captureStream();
    app = buildApp(stream);

    // Route handler emits its own log — not from requestLogger
    app.get("/context", async (request) => {
      request.log.info("handler log entry");
      return { ok: true };
    });
    await app.ready();

    await app.inject({
      method: "GET",
      url: "/context",
      headers: { "x-request-id": VALID_UUID },
    });

    // All entries captured during the request must carry the correct requestId
    const requestEntries = logs.filter(
      (l) => typeof l["requestId"] !== "undefined"
    );
    expect(requestEntries.length).toBeGreaterThan(0);
    for (const entry of requestEntries) {
      expect(entry["requestId"]).toBe(VALID_UUID);
    }
  });

  it("uses incoming x-request-id when it is a valid UUID", async () => {
    const { logs, stream } = captureStream();
    app = buildApp(stream);
    app.get("/context", async () => ({ ok: true }));
    await app.ready();

    await app.inject({
      method: "GET",
      url: "/context",
      headers: { "x-request-id": VALID_UUID },
    });

    const entry = logs.find((l) => l["requestId"] !== undefined);
    expect(entry?.["requestId"]).toBe(VALID_UUID);
  });

  it("generates a fresh ID when x-request-id is not a valid UUID", async () => {
    const { logs, stream } = captureStream();
    app = buildApp(stream);
    app.get("/context", async () => ({ ok: true }));
    await app.ready();

    await app.inject({
      method: "GET",
      url: "/context",
      headers: { "x-request-id": "not-a-uuid" },
    });

    const entry = logs.find((l) => l["requestId"] !== undefined);
    expect(entry?.["requestId"]).toBe("generated-id");
    expect(entry?.["requestId"]).not.toBe("not-a-uuid");
  });
});
