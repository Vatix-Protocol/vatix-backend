/**
 * Concurrent Order Placement Tests (#614)
 *
 * Verifies that the matching engine's per-book serialization lock prevents
 * data races when multiple orders for the same market are placed concurrently.
 *
 * Acceptance criteria:
 *  - Concurrent orders to the same book are all accepted (no 5xx / lost update)
 *  - Final DB state is consistent (quantities are correct, no phantom fills)
 *  - Orders to different markets are not blocked by each other's lock
 *  - Self-trade detection still fires correctly under concurrency
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
import { buildTestApp, resetRateLimits } from "./helpers/build-test-app.js";
import { testUtils, getTestPrismaClient } from "../setup.js";
import {
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../helpers/test-database.js";
import { matchingService } from "../../src/matching/matching-service.js";
import { settlementQueue } from "../../src/services/settlement-queue.js";

// ---------------------------------------------------------------------------
// Real keypairs for valid Ed25519 signatures
// ---------------------------------------------------------------------------

const keypairs = Array.from({ length: 5 }, () => Keypair.random());
const addresses = keypairs.map((kp) => kp.publicKey());

/** Build auth headers for a POST /v1/orders request. */
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Concurrent order placement — same order book", () => {
  let app: FastifyInstance;
  const prisma = getTestPrismaClient();

  beforeAll(async () => {
    await acquireDatabaseLock();
    app = await buildTestApp({ plugins: [ordersRoutes] });
    vi.spyOn(settlementQueue, "enqueue").mockResolvedValue(undefined);
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

  // -------------------------------------------------------------------------
  // Core: two concurrent BUY orders on the same book — no match
  // -------------------------------------------------------------------------

  it("accepts both orders when two BUYs hit the same book concurrently", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const payload1 = {
      marketId: market.id,
      userAddress: addresses[0],
      side: "BUY",
      outcome: "YES",
      price: 0.3,
      quantity: 50,
    };
    const payload2 = {
      marketId: market.id,
      userAddress: addresses[1],
      side: "BUY",
      outcome: "YES",
      price: 0.35,
      quantity: 60,
    };

    const [res1, res2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: authHeaders(keypairs[0], payload1),
        payload: payload1,
      }),
      app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: authHeaders(keypairs[1], payload2),
        payload: payload2,
      }),
    ]);

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);

    const body1 = JSON.parse(res1.body);
    const body2 = JSON.parse(res2.body);
    expect(body1.order.status).toBe("OPEN");
    expect(body2.order.status).toBe("OPEN");
  });

  it("persists both orders in the DB with correct quantities", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const qty1 = 40;
    const qty2 = 70;

    const payload1 = {
      marketId: market.id,
      userAddress: addresses[0],
      side: "BUY",
      outcome: "YES",
      price: 0.3,
      quantity: qty1,
    };
    const payload2 = {
      marketId: market.id,
      userAddress: addresses[1],
      side: "BUY",
      outcome: "YES",
      price: 0.35,
      quantity: qty2,
    };

    await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: authHeaders(keypairs[0], payload1),
        payload: payload1,
      }),
      app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: authHeaders(keypairs[1], payload2),
        payload: payload2,
      }),
    ]);

    const orders = await prisma.order.findMany({
      where: { marketId: market.id },
      orderBy: { createdAt: "asc" },
    });

    expect(orders).toHaveLength(2);
    const quantities = orders.map((o) => o.quantity).sort((a, b) => a - b);
    expect(quantities).toEqual([qty1, qty2].sort((a, b) => a - b));
  });

  // -------------------------------------------------------------------------
  // Concurrent orders that DO cross (one fills the other)
  // -------------------------------------------------------------------------

  it("correctly fills crossing orders placed concurrently", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // Pre-seed a resting SELL order at 0.5
    await testUtils.createTestOrder(market.id, addresses[2], {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
    });

    // Two concurrent BUY orders that both cross the resting SELL
    const payload1 = {
      marketId: market.id,
      userAddress: addresses[0],
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 60,
    };
    const payload2 = {
      marketId: market.id,
      userAddress: addresses[1],
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 60,
    };

    const [res1, res2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: authHeaders(keypairs[0], payload1),
        payload: payload1,
      }),
      app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: authHeaders(keypairs[1], payload2),
        payload: payload2,
      }),
    ]);

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);

    const body1 = JSON.parse(res1.body);
    const body2 = JSON.parse(res2.body);

    // Combined filled quantity must not exceed the resting 100 shares
    const totalFilled =
      (body1.filledQuantity as number) + (body2.filledQuantity as number);
    expect(totalFilled).toBeLessThanOrEqual(100);

    // At least one order should have been matched
    expect(totalFilled).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // High-fan-out: many concurrent orders from distinct users
  // -------------------------------------------------------------------------

  it("serializes N concurrent SELL orders — all return 201, no duplicated fills", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const concurrency = 5;
    const priceIncrement = 0.01;

    const requests = keypairs.slice(0, concurrency).map((kp, i) => {
      const payload = {
        marketId: market.id,
        userAddress: addresses[i],
        side: "SELL" as const,
        outcome: "YES" as const,
        price: parseFloat((0.6 + i * priceIncrement).toFixed(2)),
        quantity: 20,
      };
      return app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: authHeaders(kp, payload),
        payload,
      });
    });

    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.every((s) => s === 201)).toBe(true);

    // Verify distinct order IDs (no duplicate writes)
    const ids = responses.map((r) => JSON.parse(r.body).order.id as string);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(concurrency);
  });

  // -------------------------------------------------------------------------
  // Cross-market independence: orders on different markets are not serialized
  // -------------------------------------------------------------------------

  it("orders on different markets proceed independently (no cross-lock)", async () => {
    const marketA = await testUtils.createTestMarket({ status: "ACTIVE" });
    const marketB = await testUtils.createTestMarket({ status: "ACTIVE" });

    const payloadA = {
      marketId: marketA.id,
      userAddress: addresses[0],
      side: "BUY" as const,
      outcome: "YES" as const,
      price: 0.4,
      quantity: 30,
    };
    const payloadB = {
      marketId: marketB.id,
      userAddress: addresses[1],
      side: "BUY" as const,
      outcome: "YES" as const,
      price: 0.4,
      quantity: 30,
    };

    const [resA, resB] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: authHeaders(keypairs[0], payloadA),
        payload: payloadA,
      }),
      app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: authHeaders(keypairs[1], payloadB),
        payload: payloadB,
      }),
    ]);

    expect(resA.statusCode).toBe(201);
    expect(resB.statusCode).toBe(201);

    const orderA = JSON.parse(resA.body).order;
    const orderB = JSON.parse(resB.body).order;
    expect(orderA.marketId).toBe(marketA.id);
    expect(orderB.marketId).toBe(marketB.id);
  });

  // -------------------------------------------------------------------------
  // Self-trade detection under concurrency
  // -------------------------------------------------------------------------

  it("rejects self-trade even when submitted concurrently with another order", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // Resting SELL from user[0]
    await testUtils.createTestOrder(market.id, addresses[0], {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
    });

    // Self-trade from user[0], and a legitimate BUY from user[1] — submitted together
    const selfPayload = {
      marketId: market.id,
      userAddress: addresses[0],
      side: "BUY" as const,
      outcome: "YES" as const,
      price: 0.5,
      quantity: 100,
    };
    const legitimatePayload = {
      marketId: market.id,
      userAddress: addresses[1],
      side: "BUY" as const,
      outcome: "YES" as const,
      price: 0.3,
      quantity: 20,
    };

    const [selfRes, legitRes] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: authHeaders(keypairs[0], selfPayload),
        payload: selfPayload,
      }),
      app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: authHeaders(keypairs[1], legitimatePayload),
        payload: legitimatePayload,
      }),
    ]);

    // Self-trade must be rejected
    expect(selfRes.statusCode).toBe(400);
    expect(JSON.parse(selfRes.body).error).toMatch(/self-trade/i);

    // Legitimate order must succeed
    expect(legitRes.statusCode).toBe(201);
  });

  // -------------------------------------------------------------------------
  // Book state integrity after concurrent fills
  // -------------------------------------------------------------------------

  it("book state is consistent after concurrent partial fills", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // Pre-seed a large resting SELL
    const restingQty = 200;
    await testUtils.createTestOrder(market.id, addresses[2], {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: restingQty,
      filledQuantity: 0,
      status: "OPEN",
    });

    // Three concurrent BUYs each wanting 50
    const buyers = [
      { kp: keypairs[0], addr: addresses[0] },
      { kp: keypairs[1], addr: addresses[1] },
      { kp: keypairs[3], addr: addresses[3] },
    ];

    const responses = await Promise.all(
      buyers.map(({ kp, addr }) => {
        const payload = {
          marketId: market.id,
          userAddress: addr,
          side: "BUY" as const,
          outcome: "YES" as const,
          price: 0.5,
          quantity: 50,
        };
        return app.inject({
          method: "POST",
          url: "/v1/orders",
          headers: authHeaders(kp, payload),
          payload,
        });
      })
    );

    // All must succeed
    responses.forEach((r) => expect(r.statusCode).toBe(201));

    const totalFilled = responses.reduce(
      (sum, r) => sum + (JSON.parse(r.body).filledQuantity as number),
      0
    );

    // Total filled must not exceed the resting quantity
    expect(totalFilled).toBeLessThanOrEqual(restingQty);

    // DB: the resting SELL's filledQuantity must match total taker fills
    const restingOrders = await prisma.order.findMany({
      where: { marketId: market.id, side: "SELL" },
    });
    const makerFilledQty = restingOrders.reduce(
      (sum, o) => sum + o.filledQuantity,
      0
    );
    expect(makerFilledQty).toBe(totalFilled);
  });
});
