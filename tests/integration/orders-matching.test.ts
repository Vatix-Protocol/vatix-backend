/**
 * Orders Matching Integration Tests (#613)
 *
 * End-to-end integration tests for the CLOB matching engine via the
 * POST /v1/orders HTTP route. Covers:
 *
 *  - Full fill (taker quantity == resting quantity)
 *  - Partial fill (taker quantity > resting quantity)
 *  - No match (no crossing orders)
 *  - Multi-level fill (taker sweeps multiple price levels)
 *  - Price-time priority (best price filled first)
 *  - Position delta persistence after matching
 *  - Settlement queue enqueued once per trade
 *  - Trade record persisted in the trades table
 *  - Book rebuild on cold-start matches correctly
 *  - YES and NO outcomes matched independently
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
// Keypairs
// ---------------------------------------------------------------------------

const takerKeypair = Keypair.random();
const makerKeypair = Keypair.random();
const maker2Keypair = Keypair.random();
const takerAddress = takerKeypair.publicKey();
const makerAddress = makerKeypair.publicKey();
const maker2Address = maker2Keypair.publicKey();

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

describe("Orders Matching Integration — CLOB engine via POST /v1/orders", () => {
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
  // Full fill
  // -------------------------------------------------------------------------

  it("fully fills taker when quantities match exactly", async () => {
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
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.order.status).toBe("FILLED");
    expect(body.order.filledQuantity).toBe(100);
    expect(body.filledQuantity).toBe(100);
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].quantity).toBe(100);
    expect(body.trades[0].price).toBe(0.5);
  });

  it("updates maker order to FILLED in DB after full match", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const makerOrder = await testUtils.createTestOrder(
      market.id,
      makerAddress,
      {
        side: "SELL",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
        filledQuantity: 0,
        status: "OPEN",
      }
    );

    const payload = {
      marketId: market.id,
      userAddress: takerAddress,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
    };
    await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    const makerInDb = await prisma.order.findUnique({
      where: { id: makerOrder.id },
    });
    expect(makerInDb?.status).toBe("FILLED");
    expect(makerInDb?.filledQuantity).toBe(100);
  });

  // -------------------------------------------------------------------------
  // Partial fill
  // -------------------------------------------------------------------------

  it("partially fills taker when taker quantity > resting quantity", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.4,
      quantity: 30,
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
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.order.status).toBe("PARTIALLY_FILLED");
    expect(body.order.filledQuantity).toBe(30);
    expect(body.filledQuantity).toBe(30);
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].quantity).toBe(30);
  });

  it("remaining taker quantity is persisted with correct status after partial fill", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.4,
      quantity: 40,
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
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    const { order } = JSON.parse(res.body);
    const inDb = await prisma.order.findUnique({ where: { id: order.id } });
    expect(inDb?.status).toBe("PARTIALLY_FILLED");
    expect(inDb?.filledQuantity).toBe(40);
    expect(inDb?.quantity).toBe(100);
  });

  // -------------------------------------------------------------------------
  // No match
  // -------------------------------------------------------------------------

  it("leaves taker as OPEN when no crossing order exists", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const payload = {
      marketId: market.id,
      userAddress: takerAddress,
      side: "BUY",
      outcome: "YES",
      price: 0.4,
      quantity: 50,
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.order.status).toBe("OPEN");
    expect(body.order.filledQuantity).toBe(0);
    expect(body.trades).toHaveLength(0);
  });

  it("does not match BUY when bid price is below ask", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.7,
      quantity: 50,
      filledQuantity: 0,
      status: "OPEN",
    });

    const payload = {
      marketId: market.id,
      userAddress: takerAddress,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 50,
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).order.status).toBe("OPEN");
    expect(JSON.parse(res.body).trades).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Multi-level fill (sweeps price levels)
  // -------------------------------------------------------------------------

  it("sweeps multiple price levels in a single taker order", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 50,
      filledQuantity: 0,
      status: "OPEN",
    });
    await testUtils.createTestOrder(market.id, maker2Address, {
      side: "SELL",
      outcome: "YES",
      price: 0.55,
      quantity: 50,
      filledQuantity: 0,
      status: "OPEN",
    });

    const payload = {
      marketId: market.id,
      userAddress: takerAddress,
      side: "BUY",
      outcome: "YES",
      price: 0.6,
      quantity: 100,
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.order.status).toBe("FILLED");
    expect(body.order.filledQuantity).toBe(100);
    expect(body.trades).toHaveLength(2);

    const totalTraded = (body.trades as { quantity: number }[]).reduce(
      (sum, t) => sum + t.quantity,
      0
    );
    expect(totalTraded).toBe(100);
  });

  // -------------------------------------------------------------------------
  // Price-time priority
  // -------------------------------------------------------------------------

  it("fills best-priced resting order first (price priority)", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // SELL at 0.45 added first, SELL at 0.5 added second
    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.45,
      quantity: 50,
      filledQuantity: 0,
      status: "OPEN",
    });
    await testUtils.createTestOrder(market.id, maker2Address, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 50,
      filledQuantity: 0,
      status: "OPEN",
    });

    const payload = {
      marketId: market.id,
      userAddress: takerAddress,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 50,
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].price).toBe(0.45); // best price filled first
    expect(body.trades[0].quantity).toBe(50);
  });

  // -------------------------------------------------------------------------
  // Position deltas
  // -------------------------------------------------------------------------

  it("creates buyer position with correct yesShares after fill", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 80,
      filledQuantity: 0,
      status: "OPEN",
    });

    const payload = {
      marketId: market.id,
      userAddress: takerAddress,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 80,
    };
    await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    const position = await prisma.userPosition.findUnique({
      where: {
        marketId_userAddress: {
          marketId: market.id,
          userAddress: takerAddress,
        },
      },
    });
    expect(position).not.toBeNull();
    expect(position?.yesShares).toBe(80);
    expect(position?.noShares).toBe(0);
  });

  it("creates seller position with negative yesShares after fill", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 60,
      filledQuantity: 0,
      status: "OPEN",
    });

    const payload = {
      marketId: market.id,
      userAddress: takerAddress,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 60,
    };
    await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    const makerPosition = await prisma.userPosition.findUnique({
      where: {
        marketId_userAddress: {
          marketId: market.id,
          userAddress: makerAddress,
        },
      },
    });
    expect(makerPosition).not.toBeNull();
    expect(makerPosition?.yesShares).toBe(-60);
  });

  it("increments existing position on subsequent fills in same market", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // First fill: 50 shares
    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 50,
      filledQuantity: 0,
      status: "OPEN",
    });
    const p1 = {
      marketId: market.id,
      userAddress: takerAddress,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 50,
    };
    await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, p1),
      payload: p1,
    });

    // Second fill: 30 more shares
    await testUtils.createTestOrder(market.id, maker2Address, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 30,
      filledQuantity: 0,
      status: "OPEN",
    });
    const p2 = {
      marketId: market.id,
      userAddress: takerAddress,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 30,
    };
    await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, p2),
      payload: p2,
    });

    const position = await prisma.userPosition.findUnique({
      where: {
        marketId_userAddress: {
          marketId: market.id,
          userAddress: takerAddress,
        },
      },
    });
    expect(position?.yesShares).toBe(80); // 50 + 30
  });

  // -------------------------------------------------------------------------
  // Settlement queue
  // -------------------------------------------------------------------------

  it("enqueues exactly one settlement job per trade", async () => {
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
    await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    expect(settlementQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("settlement job contains correct trade metadata", async () => {
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
    await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    const call = (settlementQueue.enqueue as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.marketId).toBe(market.id);
    expect(call.outcome).toBe("YES");
    expect(call.quantity).toBe(100);
    expect(call.price).toBe(0.5);
    expect(call.buyerAddress).toBe(takerAddress);
    expect(call.sellerAddress).toBe(makerAddress);
    expect(typeof call.tradeId).toBe("string");
  });

  it("enqueues two settlement jobs when taker sweeps two price levels", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 40,
      filledQuantity: 0,
      status: "OPEN",
    });
    await testUtils.createTestOrder(market.id, maker2Address, {
      side: "SELL",
      outcome: "YES",
      price: 0.55,
      quantity: 60,
      filledQuantity: 0,
      status: "OPEN",
    });

    const payload = {
      marketId: market.id,
      userAddress: takerAddress,
      side: "BUY",
      outcome: "YES",
      price: 0.6,
      quantity: 100,
    };
    await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    expect(settlementQueue.enqueue).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Trade record persistence
  // -------------------------------------------------------------------------

  it("persists trade record in the trades table after fill", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const makerOrder = await testUtils.createTestOrder(
      market.id,
      makerAddress,
      {
        side: "SELL",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
        filledQuantity: 0,
        status: "OPEN",
      }
    );

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
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    const { order } = JSON.parse(res.body);
    const trades = await prisma.trade.findMany({
      where: { marketId: market.id },
    });

    expect(trades).toHaveLength(1);
    expect(trades[0].buyOrderId).toBe(order.id);
    expect(trades[0].sellOrderId).toBe(makerOrder.id);
    expect(trades[0].quantity).toBe(100);
    expect(Number(trades[0].price)).toBeCloseTo(0.5);
    expect(trades[0].buyerAddress).toBe(takerAddress);
    expect(trades[0].sellerAddress).toBe(makerAddress);
  });

  // -------------------------------------------------------------------------
  // Book rebuild on cold-start
  // -------------------------------------------------------------------------

  it("matches correctly after cold-start book rebuild from DB", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
    });

    // Simulate restart: wipe in-memory books
    (matchingService as any).books?.clear();

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
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.order.status).toBe("FILLED");
    expect(body.trades).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // YES and NO outcomes are independent books
  // -------------------------------------------------------------------------

  it("YES and NO books do not interfere with each other", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // Resting SELL YES
    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 50,
      filledQuantity: 0,
      status: "OPEN",
    });

    // BUY NO should not match the resting YES SELL
    const payload = {
      marketId: market.id,
      userAddress: takerAddress,
      side: "BUY",
      outcome: "NO",
      price: 0.5,
      quantity: 50,
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.order.status).toBe("OPEN");
    expect(body.trades).toHaveLength(0);
  });

  it("NO orders match against NO resting orders independently", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "NO",
      price: 0.4,
      quantity: 70,
      filledQuantity: 0,
      status: "OPEN",
    });

    const payload = {
      marketId: market.id,
      userAddress: takerAddress,
      side: "BUY",
      outcome: "NO",
      price: 0.5,
      quantity: 70,
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: authHeaders(takerKeypair, payload),
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.order.status).toBe("FILLED");
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].quantity).toBe(70);
  });
});
