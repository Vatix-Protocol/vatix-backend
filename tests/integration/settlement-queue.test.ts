/**
 * Integration test: settlement queue producer → Redis stream.
 *
 * Verifies that placing a matched order writes a settlement job to the correct
 * Redis stream key with all required payload fields — without mocking enqueue.
 * This catches regressions where the stream key, field names, or payload shape
 * drift from what the downstream consumer expects.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import Redis from "ioredis";
import { ordersRoutes } from "../../src/api/routes/orders.js";
import { buildSignableMessage } from "../../src/api/middleware/stellarAuth.js";
import { buildTestApp, resetRateLimits } from "./helpers/build-test-app.js";
import { testUtils } from "../setup.js";
import {
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../helpers/test-database.js";
import { matchingService } from "../../src/matching/matching-service.js";

const STREAM_KEY =
  `${process.env.REDIS_KEY_PREFIX ?? "vatix:"}` +
  `${process.env.SETTLEMENT_QUEUE_NAME ?? "settlement-trades"}`;

const buyerKeypair = Keypair.random();
const sellerKeypair = Keypair.random();
const buyerAddress = buyerKeypair.publicKey();
const sellerAddress = sellerKeypair.publicKey();

function authHeaders(
  keypair: Keypair,
  body: {
    marketId: string;
    userAddress: string;
    side: string;
    outcome: string;
    price: number;
    quantity: number;
  }
): Record<string, string> {
  const timestamp = Date.now();
  const sig = keypair
    .sign(buildSignableMessage({ ...body, timestamp }))
    .toString("base64");
  return { "x-signature": sig, "x-timestamp": String(timestamp) };
}

describe("Settlement queue: producer writes to Redis stream on trade match", () => {
  let app: FastifyInstance;
  let redisClient: Redis;

  beforeAll(async () => {
    await acquireDatabaseLock();
    app = await buildTestApp({ plugins: [ordersRoutes] });

    redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      lazyConnect: false,
    });
  });

  afterAll(async () => {
    await app.close();
    await redisClient.quit();
    await releaseDatabaseLock();
  });

  beforeEach(async () => {
    resetRateLimits();
    (matchingService as any).books?.clear();
    (matchingService as any).locks?.clear();
    vi.restoreAllMocks();
    // Trim stream so each test starts with a clean slate for this key.
    await redisClient.xtrim(STREAM_KEY, "MAXLEN", 0);
  });

  it("writes a settlement job to the stream when a trade is matched", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // Seed a resting SELL order for the seller.
    const sellPayload = {
      marketId: market.id,
      userAddress: sellerAddress,
      side: "SELL" as const,
      outcome: "YES" as const,
      price: 0.5,
      quantity: 10,
    };
    await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(sellerKeypair, sellPayload),
      payload: sellPayload,
    });

    // Place a crossing BUY — this should produce a trade and enqueue a job.
    const buyPayload = {
      marketId: market.id,
      userAddress: buyerAddress,
      side: "BUY" as const,
      outcome: "YES" as const,
      price: 0.5,
      quantity: 10,
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(buyerKeypair, buyPayload),
      payload: buyPayload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.trades).toHaveLength(1);

    // The enqueue is fire-and-forget; give the microtask queue a tick to flush.
    await new Promise((resolve) => setImmediate(resolve));

    const entries = await redisClient.xrange(STREAM_KEY, "-", "+");
    expect(entries.length).toBeGreaterThanOrEqual(1);

    // Parse the most recent entry's fields into an object.
    const [, fields] = entries[entries.length - 1];
    const job: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      job[fields[i]] = fields[i + 1];
    }

    expect(job.tradeId).toBeTruthy();
    expect(job.marketId).toBe(market.id);
    expect(job.outcome).toBe("YES");
    expect(job.buyerAddress).toBe(buyerAddress);
    expect(job.sellerAddress).toBe(sellerAddress);
    expect(Number(job.price)).toBeCloseTo(0.5);
    expect(Number(job.quantity)).toBe(10);
    expect(job.buyOrderId).toBeTruthy();
    expect(job.sellOrderId).toBeTruthy();
    expect(Number(job.timestamp)).toBeGreaterThan(0);
  });

  it("does not write to the stream when no match occurs", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const buyPayload = {
      marketId: market.id,
      userAddress: buyerAddress,
      side: "BUY" as const,
      outcome: "YES" as const,
      price: 0.3,
      quantity: 5,
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(buyerKeypair, buyPayload),
      payload: buyPayload,
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).trades).toHaveLength(0);

    await new Promise((resolve) => setImmediate(resolve));

    const entries = await redisClient.xrange(STREAM_KEY, "-", "+");
    expect(entries).toHaveLength(0);
  });
});
