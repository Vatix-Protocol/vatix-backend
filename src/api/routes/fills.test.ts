import { describe, it, expect, vi } from "vitest";
import fastify from "fastify";
import { fillsRoutes, parseResumeCursor } from "./fills";
import { errorHandler } from "../middleware/errorHandler";
import { fillsResumeService } from "../../services/fills-resume.js";

const VALID_WALLET = "GINJ46CDSMNOSKETX3K5DU44435TGRWIQEM7ZVI3ON3BTOOFVJJHTWXO";

const mockPrisma = {
  trade: {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
  },
};

vi.mock("../../services/prisma", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../../matching/validation", () => ({
  validateUserAddress: (addr: string) =>
    /^G[A-Z2-7]{55}$/.test(addr) ? null : "Invalid Stellar address",
  STELLAR_PUBLIC_KEY_REGEX: /^G[A-Z2-7]{55}$/,
}));

vi.mock("../middleware/rateLimiter", () => ({
  heavyReadLimiter: async () => {},
}));

vi.mock("../../services/fills-resume.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/fills-resume.js")>();
  return {
    ...actual,
    fillsResumeService: {
      parseCursor: actual.fillsResumeService.parseCursor.bind(
        actual.fillsResumeService
      ),
      detectGap: vi.fn().mockResolvedValue({ hasGap: false }),
      getReplayBounds: vi.fn().mockResolvedValue({
        minCursor: null,
        maxCursor: null,
        recordCount: 0,
      }),
      getTradesAfterCursor: vi.fn().mockResolvedValue({ trades: [] }),
    },
  };
});

describe("parseResumeCursor", () => {
  it("returns null when neither header nor query param is set", () => {
    expect(parseResumeCursor(undefined, undefined)).toBeNull();
  });

  it("prefers Last-Event-ID header over the after query param", () => {
    const result = parseResumeCursor(
      "2026-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z"
    );
    expect(result).toBe(`${new Date("2026-01-01T00:00:00.000Z").getTime()}-0`);
  });

  it("falls back to the after query param when no header is present", () => {
    const result = parseResumeCursor(undefined, "2026-02-02T00:00:00.000Z");
    expect(result).toBe(`${new Date("2026-02-02T00:00:00.000Z").getTime()}-0`);
  });

  it("takes the first value when Last-Event-ID is sent as an array", () => {
    const result = parseResumeCursor(
      ["2026-03-03T00:00:00.000Z", "2026-04-04T00:00:00.000Z"],
      undefined
    );
    expect(result).toBe(`${new Date("2026-03-03T00:00:00.000Z").getTime()}-0`);
  });

  it("returns null for an unparseable cursor instead of throwing", () => {
    expect(parseResumeCursor("not-a-date", undefined)).toBeNull();
  });

  it("returns null for an empty string cursor", () => {
    expect(parseResumeCursor("", "")).toBeNull();
  });
});

describe("Fills stream route", () => {
  // The route never calls reply.raw.end() itself — it relies on the real
  // socket tearing down both sides of the connection together when the
  // client disconnects. light-my-request's mock req/res aren't linked that
  // way, so tests capture the mock request via a hook and destroy it
  // manually to simulate the client disconnecting (equivalent to the
  // request.raw "close" event a real disconnect would fire) and let the
  // route's cleanup (clearInterval) run before the test ends.
  const createTestServer = async () => {
    const app = fastify();
    app.setErrorHandler(errorHandler);
    let capturedRequest: { destroy: () => void } | undefined;
    app.addHook("onRequest", async (request) => {
      capturedRequest = request.raw as unknown as { destroy: () => void };
    });
    await app.register(fillsRoutes);
    return { app, getCapturedRequest: () => capturedRequest };
  };

  it("returns 400 for an invalid wallet address", async () => {
    const { app } = await createTestServer();
    const response = await app.inject({
      method: "GET",
      url: "/wallets/0xInvalidAddress/fills/stream",
    });
    expect(response.statusCode).toBe(400);
  });

  it("starts the stream at 'now' on a fresh connection (no resume cursor)", async () => {
    const { app, getCapturedRequest } = await createTestServer();
    const beforeConnect = Date.now();

    const response = await app.inject({
      method: "GET",
      url: `/wallets/${VALID_WALLET}/fills/stream`,
      payloadAsStream: true,
    });

    expect(response.headers["content-type"]).toContain("text/event-stream");

    const connectedEvent = await readFirstSseEvent(response.stream());
    await disconnect(getCapturedRequest());

    expect(connectedEvent.wallet).toBe(VALID_WALLET);
    const cursorMs = Number(String(connectedEvent.cursor).split("-")[0]);
    expect(cursorMs).toBeGreaterThanOrEqual(beforeConnect);
  });

  it("resumes from the Last-Event-ID header instead of resetting to now", async () => {
    const { app, getCapturedRequest } = await createTestServer();
    const cursor = "2026-01-01T00:00:00.000Z";
    const expected = fillsResumeService.parseCursor(cursor);

    const response = await app.inject({
      method: "GET",
      url: `/wallets/${VALID_WALLET}/fills/stream`,
      headers: { "last-event-id": cursor },
      payloadAsStream: true,
    });

    const connectedEvent = await readFirstSseEvent(response.stream());
    await disconnect(getCapturedRequest());

    expect(connectedEvent.cursor).toBe(expected);
  });

  it("resumes from the ?after= query param when no header is present", async () => {
    const { app, getCapturedRequest } = await createTestServer();
    const cursor = "2026-02-02T00:00:00.000Z";
    const expected = fillsResumeService.parseCursor(cursor);

    const response = await app.inject({
      method: "GET",
      url: `/wallets/${VALID_WALLET}/fills/stream?after=${encodeURIComponent(cursor)}`,
      payloadAsStream: true,
    });

    const connectedEvent = await readFirstSseEvent(response.stream());
    await disconnect(getCapturedRequest());

    expect(connectedEvent.cursor).toBe(expected);
  });

  it("falls back to now for an unparseable resume cursor instead of erroring", async () => {
    const { app, getCapturedRequest } = await createTestServer();
    const beforeConnect = Date.now();

    const response = await app.inject({
      method: "GET",
      url: `/wallets/${VALID_WALLET}/fills/stream`,
      headers: { "last-event-id": "not-a-valid-timestamp" },
      payloadAsStream: true,
    });

    expect(response.statusCode).toBe(200);
    const connectedEvent = await readFirstSseEvent(response.stream());
    await disconnect(getCapturedRequest());

    const cursorMs = Number(String(connectedEvent.cursor).split("-")[0]);
    expect(cursorMs).toBeGreaterThanOrEqual(beforeConnect);
  });
});

/** Destroys the mock request to fire "close", then yields a couple of ticks
 *  so the route's request.raw.on("close") handler runs and clears its
 *  timers before the test ends. */
async function disconnect(
  request: { destroy: () => void } | undefined
): Promise<void> {
  request?.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** Reads only the first SSE message from the stream (up to the first blank
 *  line) instead of waiting for the stream to end, since this route's
 *  stream never ends on its own within a test. */
function readFirstSseEvent(stream: NodeJS.ReadableStream): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const idx = buffer.indexOf("\n\n");
      if (idx !== -1) {
        cleanup();
        resolve(parseSseEvent(buffer.slice(0, idx) + "\n\n", "connected"));
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
    };
    stream.on("data", onData);
    stream.on("error", onError);
  });
}

function parseSseEvent(body: string, eventName: string): any {
  const messages = body.split("\n\n").filter(Boolean);
  for (const message of messages) {
    const lines = message.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event: "));
    if (eventLine?.slice("event: ".length) === eventName) {
      const dataLine = lines.find((l) => l.startsWith("data: "));
      return JSON.parse(dataLine?.slice("data: ".length) ?? "{}");
    }
  }
  return undefined;
}
