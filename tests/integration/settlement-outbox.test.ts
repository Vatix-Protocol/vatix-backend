/**
 * Settlement Outbox Integration Tests
 *
 * Verifies the transactional outbox pattern end-to-end: a trade committed
 * via POST /v1/orders must be durably queued for settlement even if the
 * post-commit fast-path enqueue fails (Redis down / process crash between
 * commit and enqueue) — the outbox row is written in the SAME DB
 * transaction as the trade, so the recovery loop (drainOutboxOnce) can
 * always find and republish it later.
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
import { ordersRoutes } from "../../src/api/routes/orders.js";
import { buildSignableMessage } from "../../src/api/middleware/stellarAuth.js";
import { issueChallenge } from "../../src/api/middleware/nonceStore.js";
import { buildTestApp, resetRateLimits } from "./helpers/build-test-app.js";
import { testUtils, getTestPrismaClient } from "../setup.js";
import {
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../helpers/test-database.js";
import { matchingService } from "../../src/matching/matching-service.js";
import { settlementQueue } from "../../src/services/settlement-queue.js";
import { drainOutboxOnce } from "../../src/services/outbox-publisher.js";

const takerKeypair = Keypair.random();
const makerKeypair = Keypair.random();
const takerAddress = takerKeypair.publicKey();
const makerAddress = makerKeypair.publicKey();

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

describe("Settlement Outbox — durable trade -> settlement queue delivery", () => {
  let app: FastifyInstance;
  const prisma = getTestPrismaClient();

  beforeAll(async () => {
    await acquireDatabaseLock();
    app = await buildTestApp({ plugins: [ordersRoutes] });
  });

  afterAll(async () => {
    await app.close();
    await releaseDatabaseLock();
  });

  beforeEach(() => {
    resetRateLimits();
    (matchingService as any).books?.clear();
    (matchingService as any).locks?.clear();
    vi.clearAllMocks();
  });

  async function placeCrossingOrders(): Promise<{ marketId: string }> {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
    });

    const payload = {
      marketId: market.id,
      userAddress: takerAddress,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: await authHeaders(takerKeypair, payload),
      payload,
    });

    expect(res.statusCode).toBe(201);
    return { marketId: market.id };
  }

  it("never permanently drops settlement when Redis is down between commit and enqueue", async () => {
    // Simulate Redis being unreachable for the fast-path enqueue that runs
    // immediately after the DB transaction commits.
    vi.spyOn(settlementQueue, "enqueue").mockRejectedValue(
      new Error("ECONNREFUSED: redis down")
    );

    await placeCrossingOrders();

    // The trade is durably committed regardless of the enqueue failure.
    const trades = await prisma.trade.findMany();
    expect(trades).toHaveLength(1);
    const tradeId = trades[0].tradeId;

    // The outbox row for that trade exists and reflects the failed publish
    // attempt — it is NOT lost, just not yet published.
    const outboxRow = await (prisma as any).outboxEvent.findUnique({
      where: { tradeId },
    });
    expect(outboxRow).not.toBeNull();
    expect(outboxRow.status).toBe("FAILED");
    expect(outboxRow.publishedAt).toBeNull();
    expect(outboxRow.attempts).toBeGreaterThanOrEqual(1);

    // Recovery: Redis comes back. The publisher's background drain loop
    // (started by the settlement worker process) picks the row up and
    // republishes it — simulated here via a single drain call.
    vi.spyOn(settlementQueue, "enqueue").mockResolvedValue(undefined);
    await (prisma as any).outboxEvent.update({
      where: { tradeId },
      data: { nextAttemptAt: new Date() },
    });

    const result = await drainOutboxOnce(prisma as any, 10);
    expect(result.published).toBe(1);
    expect(settlementQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ tradeId })
    );

    const publishedRow = await (prisma as any).outboxEvent.findUnique({
      where: { tradeId },
    });
    expect(publishedRow.status).toBe("PUBLISHED");
    expect(publishedRow.publishedAt).not.toBeNull();
  });

  it("crash mid-publish: outbox row survives even if the fast path never runs at all", async () => {
    // Simulate a hard process crash right after the DB transaction commits,
    // before the fast-path enqueue loop executes at all. We approximate
    // this by making enqueue throw synchronously for every fast-path call —
    // from the DB's perspective this is indistinguishable from "the process
    // died before publishing": the trade is committed, the outbox row is
    // PENDING/FAILED, and nothing besides the background drain loop moves
    // it forward.
    vi.spyOn(settlementQueue, "enqueue").mockRejectedValue(
      new Error("process crashed")
    );

    await placeCrossingOrders();

    const trades = await prisma.trade.findMany();
    const tradeId = trades[0].tradeId;

    let row = await (prisma as any).outboxEvent.findUnique({
      where: { tradeId },
    });
    expect(row.status).not.toBe("PUBLISHED");

    // Two independent drain calls race for the same row (e.g. worker
    // restarted mid-drain and a second instance also picks it up). Neither
    // should error, and the row must converge on PUBLISHED exactly once in
    // terms of final state — duplicate settlementQueue.enqueue calls are
    // acceptable because settlement consumer idempotency-checks on tradeId.
    vi.spyOn(settlementQueue, "enqueue").mockResolvedValue(undefined);
    await (prisma as any).outboxEvent.update({
      where: { tradeId },
      data: { nextAttemptAt: new Date() },
    });

    await Promise.all([
      drainOutboxOnce(prisma as any, 10),
      drainOutboxOnce(prisma as any, 10),
    ]);

    row = await (prisma as any).outboxEvent.findUnique({ where: { tradeId } });
    expect(row.status).toBe("PUBLISHED");

    // No duplicate trade rows were ever created — trade persistence is
    // upserted on tradeId independently of how many times settlement
    // publish was retried.
    const allTrades = await prisma.trade.findMany({ where: { tradeId } });
    expect(allTrades).toHaveLength(1);
  });

  it("publishes successfully on the fast path when Redis is healthy (no outbox backlog)", async () => {
    vi.spyOn(settlementQueue, "enqueue").mockResolvedValue(undefined);

    await placeCrossingOrders();

    const trades = await prisma.trade.findMany();
    const tradeId = trades[0].tradeId;

    const row = await (prisma as any).outboxEvent.findUnique({
      where: { tradeId },
    });
    expect(row.status).toBe("PUBLISHED");
    expect(row.publishedAt).not.toBeNull();
  });
});
