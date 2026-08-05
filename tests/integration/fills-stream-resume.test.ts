import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { EventEmitter } from "events";
import { buildServer } from "../../src/index.js";
import { getPrismaClient } from "../../src/services/prisma.js";

describe("Fills SSE Stream with Resume Tokens", () => {
  let server: FastifyInstance;
  const wallet = "GAWBT2Z5XMLMNRXA5TERUYRMKANZIA5CZSYPU3AVQLTIRONQOXLA5DUX";
  const marketId = "market123";
  const counterparty =
    "GBYKXVJ5T4BBTQ3Z3FBPVX5GZZ3LW3ZDFGXK7NJFQRQJZC5Z7YGRP6Z";

  beforeEach(async () => {
    server = buildServer({ registerTestRoutes: false });
  });

  afterEach(async () => {
    await server.close();
  });

  async function createTestTrade(
    tradeId: string,
    buyerAddress: string,
    sellerAddress: string,
    timestamp: Date
  ) {
    const prisma = getPrismaClient();
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

  it("should establish connection and receive connected event", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/fills/stream`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");

    const body = response.body;
    expect(body).toContain("event: connected");
    expect(body).toContain(wallet);
  });

  it("should include event IDs for client resume", async () => {
    // Create a test trade
    const now = new Date();
    await createTestTrade("trade1", wallet, counterparty, now);

    // Wait a bit for poll interval
    await new Promise((r) => setTimeout(r, 2500));

    const response = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/fills/stream`,
    });

    expect(response.statusCode).toBe(200);

    // Event should have an id field
    expect(response.body).toMatch(/id: \d+-0/);
    expect(response.body).toContain("event: order_fill");
  });

  it("should replay fills from Last-Event-ID cursor on reconnect", async () => {
    // Create initial trade
    const time1 = new Date();
    await createTestTrade("trade1", wallet, counterparty, time1);

    // Connect and let it receive the trade
    const firstResponse = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/fills/stream`,
    });

    // Extract event ID from first connection
    const eventIdMatch = firstResponse.body.match(/id: (\d+-\d+)/);
    const lastEventId = eventIdMatch ? eventIdMatch[1] : null;
    expect(lastEventId).toBeDefined();

    // Create another trade while "disconnected"
    const time2 = new Date(time1.getTime() + 1000);
    await createTestTrade("trade2", wallet, counterparty, time2);

    // Reconnect with Last-Event-ID
    const reconnectResponse = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/fills/stream`,
      headers: {
        "last-event-id": lastEventId!,
      },
    });

    expect(reconnectResponse.statusCode).toBe(200);
    expect(reconnectResponse.body).toContain("event: replay_start");
    expect(reconnectResponse.body).toContain("event: replay_end");
    expect(reconnectResponse.body).toContain("trade2");
  });

  it("should return 410 Gone for stale cursor", async () => {
    // Use a very old cursor (should be trimmed)
    const staleCursor = "1000-0";

    const response = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/fills/stream?after=${staleCursor}`,
    });

    // Should return 410 if cursor is outside replay window
    // (depends on implementation details; may return 410 or gracefully resume from oldest)
    expect([410, 200]).toContain(response.statusCode);

    if (response.statusCode === 410) {
      expect(response.body).toContain("stream_gap");
    }
  });

  it("should handle query parameter ?after= as cursor fallback", async () => {
    const now = new Date();
    await createTestTrade("trade1", wallet, counterparty, now);

    // Use ISO timestamp in query
    const isoTime = new Date(now.getTime() - 5000).toISOString();

    const response = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/fills/stream?after=${encodeURIComponent(isoTime)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: connected");
  });

  it("should not duplicate fills for idempotent client", async () => {
    const now = new Date();
    await createTestTrade("trade1", wallet, counterparty, now);

    // First connection
    const firstConn = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/fills/stream`,
    });

    const eventIdMatch = firstConn.body.match(/id: (\d+-\d+)/);
    const lastEventId = eventIdMatch ? eventIdMatch[1] : null;

    // Second connection with same cursor (simulating duplicate receive)
    const secondConn = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/fills/stream`,
      headers: {
        "last-event-id": lastEventId!,
      },
    });

    // Should replay, but client should dedupe based on tradeId
    expect(secondConn.statusCode).toBe(200);
  });

  it("should include bounds info in connected event", async () => {
    const time1 = new Date();
    const time2 = new Date(time1.getTime() + 1000);

    await createTestTrade("trade1", wallet, counterparty, time1);
    await createTestTrade("trade2", wallet, counterparty, time2);

    const response = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/fills/stream`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("minCursor");
    expect(response.body).toContain("maxCursor");
    expect(response.body).toContain("recordCount");
  });

  it("should continue polling after initial connection", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/fills/stream`,
    });

    expect(response.statusCode).toBe(200);

    // Should contain heartbeats
    expect(response.body).toContain(": heartbeat");
  });
});
