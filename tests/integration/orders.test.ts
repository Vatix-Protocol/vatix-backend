import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { ordersRoutes } from "../../src/api/routes/orders.js";
import { errorHandler } from "../../src/api/middleware/errorHandler.js";
import { testUtils, getTestPrismaClient } from "../setup.js";
import {
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../helpers/test-database.js";
import { matchingService } from "../../src/matching/matching-service.js";
import { settlementQueue } from "../../src/services/settlement-queue.js";

const validAddress = testUtils.generateStellarAddress("GUSER");
const makerAddress = testUtils.generateStellarAddress("GMAKER");

describe("Integration Tests: POST /v1/orders with Matching", () => {
  let app: FastifyInstance;
  const prisma = getTestPrismaClient();

  beforeAll(async () => {
    await acquireDatabaseLock();
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(ordersRoutes, { prefix: "/v1" });

    // Mock settlement queue to track calls
    vi.spyOn(settlementQueue, "enqueue").mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app.close();
    await releaseDatabaseLock();
  });

  beforeEach(async () => {
    // Clear matching service book cache between tests
    (matchingService as any).books.clear();
    (matchingService as any).locks.clear();
    vi.clearAllMocks();
  });

  it("should match two crossing orders and return both FILLED", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // Maker: sell order at 0.5
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

    // Taker: buy order at 0.5 (should match fully)
    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);

    // Taker should be FILLED
    expect(body.order.status).toBe("FILLED");
    expect(body.order.filledQuantity).toBe(100);
    expect(body.filledQuantity).toBe(100);

    // Should have 1 trade
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].price).toBe(0.5);
    expect(body.trades[0].quantity).toBe(100);
    expect(body.trades[0].buyOrderId).toBe(body.order.id);
    expect(body.trades[0].sellOrderId).toBe(makerOrder.id);

    // Maker should be FILLED in DB
    const makerInDb = await prisma.order.findUnique({
      where: { id: makerOrder.id },
    });
    expect(makerInDb?.status).toBe("FILLED");
    expect(makerInDb?.filledQuantity).toBe(100);

    // Settlement queue should be called once
    expect(settlementQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("should create PARTIALLY_FILLED orders on partial match", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // Maker: sell 50 at 0.4
    const makerOrder = await testUtils.createTestOrder(
      market.id,
      makerAddress,
      {
        side: "SELL",
        outcome: "YES",
        price: 0.4,
        quantity: 50,
        filledQuantity: 0,
        status: "OPEN",
      }
    );

    // Taker: buy 100 at 0.5 (only 50 will match, 50 will rest)
    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);

    // Taker should be PARTIALLY_FILLED
    expect(body.order.status).toBe("PARTIALLY_FILLED");
    expect(body.order.filledQuantity).toBe(50);
    expect(body.filledQuantity).toBe(50);

    // Should have 1 trade
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].quantity).toBe(50);

    // Maker should be FILLED
    const makerInDb = await prisma.order.findUnique({
      where: { id: makerOrder.id },
    });
    expect(makerInDb?.status).toBe("FILLED");
    expect(makerInDb?.filledQuantity).toBe(50);

    // Taker should be in DB with PARTIALLY_FILLED status
    const takerInDb = await prisma.order.findUnique({
      where: { id: body.order.id },
    });
    expect(takerInDb?.status).toBe("PARTIALLY_FILLED");
    expect(takerInDb?.filledQuantity).toBe(50);
  });

  it("should create OPEN order when no match found", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // No existing orders, so this should be OPEN
    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);

    expect(body.order.status).toBe("OPEN");
    expect(body.order.filledQuantity).toBe(0);
    expect(body.filledQuantity).toBe(0);
    expect(body.trades).toHaveLength(0);

    // Order should be visible in orderbook API
    const ordersResponse = await app.inject({
      method: "GET",
      url: `/v1/orders/user/${validAddress}`,
    });
    expect(ordersResponse.statusCode).toBe(200);
    const ordersBody = JSON.parse(ordersResponse.body);
    expect(ordersBody.orders).toHaveLength(1);
    expect(ordersBody.orders[0].status).toBe("OPEN");
  });

  it("should update UserPosition after match", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // Maker: sell 100 YES at 0.5
    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
    });

    // Taker: buy 100 YES at 0.5
    await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
      },
    });

    // Taker should have +100 YES shares
    let takerPos = await prisma.userPosition.findUnique({
      where: {
        marketId_userAddress: {
          marketId: market.id,
          userAddress: validAddress,
        },
      },
    });
    expect(takerPos?.yesShares).toBe(100);
    expect(takerPos?.noShares).toBe(0);

    // Maker should have -100 YES shares
    let makerPos = await prisma.userPosition.findUnique({
      where: {
        marketId_userAddress: {
          marketId: market.id,
          userAddress: makerAddress,
        },
      },
    });
    expect(makerPos?.yesShares).toBe(-100);
    expect(makerPos?.noShares).toBe(0);
  });

  it("should reject self-trade", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // Place a resting sell order
    await testUtils.createTestOrder(market.id, validAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
    });

    // Try to place a crossing buy order from the same user
    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/self-trade/i);
  });

  it("should enqueue settlement job per trade", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // Maker: sell 100 at 0.5
    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
    });

    // Taker: buy 100 (1 trade)
    await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
      },
    });

    // Should have called enqueue once
    expect(settlementQueue.enqueue).toHaveBeenCalledTimes(1);
    const call = (settlementQueue.enqueue as any).mock.calls[0][0];
    expect(call.marketId).toBe(market.id);
    expect(call.outcome).toBe("YES");
    expect(call.quantity).toBe(100);
    expect(call.price).toBe(0.5);
  });

  it("should serialize concurrent orders to same market", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // Create two buy orders concurrently at different prices
    const promise1 = app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.3,
        quantity: 50,
      },
    });

    const promise2 = app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress: makerAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.4,
        quantity: 50,
      },
    });

    const [response1, response2] = await Promise.all([promise1, promise2]);

    // Both should succeed and be OPEN (no matching)
    expect(response1.statusCode).toBe(201);
    expect(response2.statusCode).toBe(201);

    const body1 = JSON.parse(response1.body);
    const body2 = JSON.parse(response2.body);

    expect(body1.order.status).toBe("OPEN");
    expect(body2.order.status).toBe("OPEN");

    // Both should be in DB
    const orders = await prisma.order.findMany({
      where: { marketId: market.id },
    });
    expect(orders).toHaveLength(2);
  });

  it("should rebuild book from DB on restart (simulated)", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    // Place initial order
    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
    });

    // Clear book cache (simulating restart)
    (matchingService as any).books.clear();

    // Place matching order (book should be re-hydrated)
    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
      },
    });

    // Should still match correctly
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.trades).toHaveLength(1);
    expect(body.order.status).toBe("FILLED");
  });
});
