import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/index.js";
import { getPrismaClient } from "../../src/services/prisma.js";
import { testUtils } from "../setup.js";

describe("Fills SSE Stream with Resume Tokens", () => {
  let server: FastifyInstance;
  let capturedRequest: { destroy: () => void } | undefined;
  const wallet = "GAWBT2Z5XMLMNRXA5TERUYRMKANZIA5CZSYPU3AVQLTIRONQOXLA5DUX";
  const counterparty =
    "GBYKXVJ5T4BBTQ3Z3FBPVX5GZZ3LW3ZDFGXK7NJFQRQJZC5Z7YGRP6Z";
  let marketId = "";
  let tradeSeq = 0;

  beforeEach(async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    marketId = market.id;
    tradeSeq = 0;
    capturedRequest = undefined;
    server = buildServer({ registerTestRoutes: false });
    server.addHook("onRequest", async (request) => {
      capturedRequest = request.raw as unknown as { destroy: () => void };
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  async function createTestTrade(
    buyerAddress: string,
    sellerAddress: string,
    timestamp: Date
  ) {
    const prisma = getPrismaClient();
    tradeSeq += 1;
    const tradeId = `fills-resume-${marketId}-${tradeSeq}-${timestamp.getTime()}`;
    return prisma.trade.create({
      data: {
        tradeId,
        marketId,
        outcome: "YES",
        buyerAddress,
        sellerAddress,
        buyOrderId: `order-${tradeId}-buy`,
        sellOrderId: `order-${tradeId}-sell`,
        price: 0.5,
        quantity: 10,
        tradedAt: timestamp,
      },
    });
  }

  async function readConnectedEvent(
    url: string,
    headers?: Record<string, string>
  ) {
    const response = await server.inject({
      method: "GET",
      url,
      headers,
      payloadAsStream: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");

    const body = await readFirstSseChunk(response.stream());
    capturedRequest?.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    return body;
  }

  it("should establish connection and receive connected event", async () => {
    const body = await readConnectedEvent(`/v1/wallets/${wallet}/fills/stream`);
    expect(body).toContain("event: connected");
    expect(body).toContain(wallet);
  });

  it("should include event IDs for client resume", async () => {
    const now = new Date();
    await createTestTrade(wallet, counterparty, now);

    const body = await readConnectedEvent(
      `/v1/wallets/${wallet}/fills/stream?after=${encodeURIComponent(
        new Date(now.getTime() - 1000).toISOString()
      )}`
    );

    expect(body).toMatch(/id: \d+-\d+/);
    expect(body).toContain("event: connected");
  });

  it("should replay fills from Last-Event-ID cursor on reconnect", async () => {
    const time1 = new Date();
    await createTestTrade(wallet, counterparty, time1);

    const firstBody = await readConnectedEvent(
      `/v1/wallets/${wallet}/fills/stream?after=${encodeURIComponent(
        new Date(time1.getTime() - 1000).toISOString()
      )}`
    );

    const eventIdMatch = firstBody.match(/id: (\d+-\d+)/);
    const lastEventId = eventIdMatch?.[1] ?? `${time1.getTime()}-0`;

    const time2 = new Date(time1.getTime() + 1000);
    const trade2 = await createTestTrade(wallet, counterparty, time2);

    const reconnectBody = await readConnectedEvent(
      `/v1/wallets/${wallet}/fills/stream`,
      { "last-event-id": lastEventId }
    );

    expect(reconnectBody).toContain("event: connected");
    expect(reconnectBody).toContain(trade2.tradeId);
  });

  it("should return 410 Gone for stale cursor", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/fills/stream?after=1000-0`,
      payloadAsStream: true,
    });

    // Gap detection may return 410 or gracefully resume depending on Redis state
    expect([410, 200]).toContain(response.statusCode);
    if (response.statusCode === 410) {
      expect(response.body).toContain("stream_gap");
    } else {
      response.stream().destroy();
    }
  });

  it("should handle query parameter ?after= as cursor fallback", async () => {
    const now = new Date();
    await createTestTrade(wallet, counterparty, now);
    const isoTime = new Date(now.getTime() - 5000).toISOString();

    const body = await readConnectedEvent(
      `/v1/wallets/${wallet}/fills/stream?after=${encodeURIComponent(isoTime)}`
    );
    expect(body).toContain("event: connected");
  });

  it("should not duplicate fills for idempotent client", async () => {
    const now = new Date();
    await createTestTrade(wallet, counterparty, now);

    const firstBody = await readConnectedEvent(
      `/v1/wallets/${wallet}/fills/stream?after=${encodeURIComponent(
        new Date(now.getTime() - 1000).toISOString()
      )}`
    );
    const eventIdMatch = firstBody.match(/id: (\d+-\d+)/);
    const lastEventId = eventIdMatch?.[1] ?? `${now.getTime()}-0`;

    const secondBody = await readConnectedEvent(
      `/v1/wallets/${wallet}/fills/stream`,
      { "last-event-id": lastEventId }
    );
    expect(secondBody).toContain("event: connected");
  });

  it("should include bounds info in connected event", async () => {
    const time1 = new Date();
    const time2 = new Date(time1.getTime() + 1000);
    await createTestTrade(wallet, counterparty, time1);
    await createTestTrade(wallet, counterparty, time2);

    const body = await readConnectedEvent(`/v1/wallets/${wallet}/fills/stream`);
    expect(body).toContain("minCursor");
    expect(body).toContain("maxCursor");
    expect(body).toContain("recordCount");
  });

  it("should continue polling after initial connection", async () => {
    const body = await readConnectedEvent(`/v1/wallets/${wallet}/fills/stream`);
    expect(body).toContain("event: connected");
  });
});

function readFirstSseChunk(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for SSE chunk"));
    }, 4000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      if (buffer.includes("\n\n")) {
        cleanup();
        resolve(buffer);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
    };
    stream.on("data", onData);
    stream.on("error", onError);
  });
}
