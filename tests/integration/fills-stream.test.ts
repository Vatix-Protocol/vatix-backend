import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, resetRateLimits } from "./helpers/build-test-app.js";
import { getTestPrismaClient } from "../helpers/test-database.js";
import { testUtils } from "../setup.js";

/** Incrementally parses SSE frames off a single fetch() response body. */
class SseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  /** Reads until `predicate` matches a parsed event, or times out. */
  async readUntil(
    predicate: (event: { event: string; data: unknown }) => boolean,
    timeoutMs = 5000
  ): Promise<{ event: string; data: unknown }> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      let frameEnd: number;
      while ((frameEnd = this.buffer.indexOf("\n\n")) !== -1) {
        const frame = this.buffer.slice(0, frameEnd);
        this.buffer = this.buffer.slice(frameEnd + 2);

        const eventLine = frame
          .split("\n")
          .find((l) => l.startsWith("event: "));
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!eventLine || !dataLine) continue;

        const parsed = {
          event: eventLine.slice("event: ".length),
          data: JSON.parse(dataLine.slice("data: ".length)),
        };
        if (predicate(parsed)) return parsed;
      }

      const { value, done } = await Promise.race([
        this.reader.read(),
        new Promise<{ value: undefined; done: false }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: false }), 200)
        ),
      ]);

      if (value) this.buffer += this.decoder.decode(value, { stream: true });
      if (done) break;
    }

    throw new Error("timed out waiting for matching SSE event");
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }
}

describe("GET /v1/wallets/:wallet/fills/stream", () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.ORDER_FILL_STREAM_POLL_MS = "50";
    const { fillsRoutes } = await import("../../src/api/routes/fills.js");

    app = await buildTestApp({ plugins: [fillsRoutes] });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = address;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetRateLimits();
  });

  it("rejects an invalid wallet address with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/wallets/not-a-wallet/fills/stream",
    });
    expect(res.statusCode).toBe(400);
  });

  it("streams a connected event, then an order_fill event for a new trade", async () => {
    const wallet = testUtils.generateStellarAddress("GFILLBUYER");
    const counterparty = testUtils.generateStellarAddress("GFILLSELLER");
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const controller = new AbortController();
    const response = await fetch(
      `${baseUrl}/v1/wallets/${wallet}/fills/stream`,
      { signal: controller.signal }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const sse = new SseReader(response.body!);
    try {
      const connected = await sse.readUntil((e) => e.event === "connected");
      expect((connected.data as { wallet: string }).wallet).toBe(wallet);

      const prisma = getTestPrismaClient();
      await prisma.trade.create({
        data: {
          tradeId: "fill-stream-trade-1",
          marketId: market.id,
          outcome: "YES",
          buyerAddress: wallet,
          sellerAddress: counterparty,
          buyOrderId: "buy-order-1",
          sellOrderId: "sell-order-1",
          price: "0.42",
          quantity: 7,
          tradedAt: new Date(),
        },
      });

      const fill = await sse.readUntil((e) => e.event === "order_fill");
      const data = fill.data as Record<string, unknown>;
      expect(data.tradeId).toBe("fill-stream-trade-1");
      expect(data.marketId).toBe(market.id);
      expect(data.side).toBe("BUY");
      expect(data.counterpartyAddress).toBe(counterparty);
      expect(data.price).toBe(0.42);
      expect(data.quantity).toBe(7);
      expect(typeof data.tradedAt).toBe("string");
    } finally {
      await sse.close();
      controller.abort();
    }
  });
});
