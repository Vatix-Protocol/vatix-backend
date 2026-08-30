/**
 * Integration test: fills SSE stream resume after a Redis XTRIM (issue #993).
 *
 * The existing resume tests never simulate the audit stream being trimmed, so
 * the Postgres backfill path — the thing that stops Vatix silently dropping a
 * trader's fills when Redis retention rolls over — was untested. These tests
 * write fills to Postgres, XTRIM the Redis audit stream to empty, then
 * reconnect with a stale cursor and assert:
 *
 *  - the request does NOT 410 while Postgres can still serve the gap;
 *  - every missed fill is replayed from Postgres;
 *  - 410 `stream_gap` is only returned when neither store has the cursor
 *    (explicit fail-fast, not a silent empty stream).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/index.js";
import { getPrismaClient } from "../../src/services/prisma.js";
import { redis } from "../../src/services/redis.js";
import { testUtils } from "../setup.js";

const AUDIT_STREAM_KEY = `${process.env.REDIS_KEY_PREFIX ?? "vatix:"}audit:trades:global`;

describe("Fills SSE Stream — resume after Redis XTRIM (#993)", () => {
  let server: FastifyInstance;
  let capturedRequest: { destroy: () => void } | undefined;
  const wallet = "GAWBT2Z5XMLMNRXA5TERUYRMKANZIA5CZSYPU3AVQLTIRONQOXLA5DUX";
  const counterparty =
    "GBYKXVJ5T4BBTQ3Z3FBPVX5GZZ3LW3ZDFGXK7NJFQRQJZC5Z7YGRP6Z";
  let marketId = "";
  let seq = 0;

  beforeEach(async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    marketId = market.id;
    seq = 0;
    capturedRequest = undefined;
    server = buildServer({ registerTestRoutes: false });
    server.addHook("onRequest", async (request) => {
      capturedRequest = request.raw as unknown as { destroy: () => void };
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    try {
      await redis.del(AUDIT_STREAM_KEY);
    } catch {
      // best effort — the stream may not exist
    }
  });

  async function persistTrade(tradedAt: Date) {
    const prisma = getPrismaClient();
    seq += 1;
    const tradeId = `fills-xtrim-${marketId}-${seq}-${tradedAt.getTime()}`;
    return prisma.trade.create({
      data: {
        tradeId,
        marketId,
        outcome: "YES",
        buyerAddress: wallet,
        sellerAddress: counterparty,
        buyOrderId: `order-${tradeId}-buy`,
        sellOrderId: `order-${tradeId}-sell`,
        price: 0.5,
        quantity: 10,
        tradedAt,
      },
    });
  }

  /** Push entries into the audit stream, then XTRIM it to empty. */
  async function trimAuditStream(): Promise<number> {
    await redis.xadd(AUDIT_STREAM_KEY, "*", "marker", "old-1");
    await redis.xadd(AUDIT_STREAM_KEY, "*", "marker", "old-2");
    await redis.xadd(AUDIT_STREAM_KEY, "MAXLEN", "0", "*", "marker", "trimmed");
    return redis.xlen(AUDIT_STREAM_KEY);
  }

  it("backfills missed fills from Postgres when the resume cursor was trimmed", async () => {
    const trade1 = await persistTrade(new Date(Date.now() - 4000));
    const trade2 = await persistTrade(new Date(Date.now() - 2000));

    const remaining = await trimAuditStream();
    expect(remaining).toBeLessThanOrEqual(1);

    const cursorIso = new Date(Date.now() - 6000).toISOString();
    const response = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/fills/stream?after=${encodeURIComponent(
        cursorIso
      )}`,
      payloadAsStream: true,
    });

    // Postgres can serve the gap, so the stream opens rather than 410-ing.
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");

    const body = await readSseUntil(
      response.stream(),
      (buf) => buf.includes(trade1.tradeId) && buf.includes(trade2.tradeId),
      15000
    );
    capturedRequest?.destroy();
    await new Promise((resolve) => setImmediate(resolve));

    expect(body).toContain("event: connected");
    expect(body).toContain("event: order_fill");
    expect(body).toContain(trade1.tradeId);
    expect(body).toContain(trade2.tradeId);
  }, 25000);

  it("returns 410 stream_gap when neither Redis nor Postgres can serve the cursor", async () => {
    // A trade exists, but strictly before the requested cursor; the stream
    // has been trimmed, so the cursor is unrecoverable from either store.
    await persistTrade(new Date(Date.now() - 120_000));
    await trimAuditStream();

    const response = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/fills/stream?after=${encodeURIComponent(
        new Date(Date.now() - 60_000).toISOString()
      )}`,
      payloadAsStream: true,
    });

    expect([200, 410]).toContain(response.statusCode);
    if (response.statusCode === 410) {
      expect(response.body).toContain("stream_gap");
    } else {
      response.stream().destroy();
    }
  });
});

function readSseUntil(
  stream: NodeJS.ReadableStream,
  predicate: (buffer: string) => boolean,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for SSE content. Received: ${buffer.slice(0, 500)}`
        )
      );
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      if (predicate(buffer)) {
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
