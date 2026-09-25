/**
 * Integration test: settlement queue producer → BullMQ.
 *
 * Verifies that placing a matched order writes a settlement job to the correct
 * BullMQ queue with all required payload fields — without mocking enqueue.
 * This catches regressions where the queue name, job data shape, or producer/consumer
 * mismatch prevents settlements from being processed.
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
import { Queue } from "bullmq";
import { ordersRoutes } from "../../src/api/routes/orders.js";
import { buildSignableMessage } from "../../src/api/middleware/stellarAuth.js";
import { issueChallenge } from "../../src/api/middleware/nonceStore.js";
import { buildTestApp, resetRateLimits } from "./helpers/build-test-app.js";
import { testUtils } from "../setup.js";
import {
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../helpers/test-database.js";
import { matchingService } from "../../src/matching/matching-service.js";
import {
  redisConnectionFromEnv,
  settlementQueueName,
} from "../../apps/workers/src/shared/queue-config.js";
import type { SettlementJob } from "../../src/services/settlement-queue.js";

const buyerKeypair = Keypair.random();
const sellerKeypair = Keypair.random();
const buyerAddress = buyerKeypair.publicKey();
const sellerAddress = sellerKeypair.publicKey();

async function authHeaders(
  keypair: Keypair,
  body: {
    marketId: string;
    userAddress: string;
    side: string;
    outcome: string;
    price: number;
    quantity: number;
  }
): Promise<Record<string, string>> {
  const timestamp = Date.now();
  const { nonce } = await issueChallenge(keypair.publicKey());
  const sig = keypair
    .sign(buildSignableMessage({ ...body, nonce, timestamp }))
    .toString("base64");
  return {
    "x-signature": sig,
    "x-timestamp": String(timestamp),
    "x-nonce": nonce,
  };
}

describe("Settlement queue: producer writes to BullMQ on trade match", () => {
  let app: FastifyInstance;
  let queue: Queue<SettlementJob>;

  beforeAll(async () => {
    await acquireDatabaseLock();
    app = await buildTestApp({ plugins: [ordersRoutes] });

    queue = new Queue<SettlementJob>(settlementQueueName(), {
      connection: redisConnectionFromEnv(),
    });
  });

  afterAll(async () => {
    await app.close();
    await queue.close();
    await releaseDatabaseLock();
  });

  beforeEach(async () => {
    resetRateLimits();
    (matchingService as any).books?.clear();
    (matchingService as any).locks?.clear();
    vi.restoreAllMocks();
    // Drain queue so each test starts clean
    await queue.drain();
  });

  it("enqueues a settlement job to BullMQ when a trade is matched", async () => {
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
      headers: await authHeaders(sellerKeypair, sellPayload),
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
      headers: await authHeaders(buyerKeypair, buyPayload),
      payload: buyPayload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.trades).toHaveLength(1);
    const tradeId = body.trades[0].id;

    // Give enqueue a moment to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const job = await queue.getJob(`settlement:${tradeId}`);
    expect(job).toBeDefined();

    const jobData = job?.data;
    expect(jobData).toBeDefined();
    expect(jobData?.tradeId).toBe(tradeId);
    expect(jobData?.marketId).toBe(market.id);
    expect(jobData?.outcome).toBe("YES");
    expect(jobData?.buyerAddress).toBe(buyerAddress);
    expect(jobData?.sellerAddress).toBe(sellerAddress);
    expect(jobData?.price).toBeCloseTo(0.5);
    expect(jobData?.quantity).toBe(10);
    expect(jobData?.buyOrderId).toBeTruthy();
    expect(jobData?.sellOrderId).toBeTruthy();
    expect(jobData?.timestamp).toBeGreaterThan(0);
  });

  it("does not enqueue a job when no match occurs", async () => {
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
      headers: await authHeaders(buyerKeypair, buyPayload),
      payload: buyPayload,
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).trades).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const count = await queue.count();
    expect(count).toBe(0);
  });
});
