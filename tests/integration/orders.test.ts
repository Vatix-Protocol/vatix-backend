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
import { ordersRoutes } from "../../src/api/routes/orders.js";
import { buildTestApp, resetRateLimits } from "./helpers/build-test-app.js";
import { testUtils, getTestPrismaClient } from "../setup.js";
import {
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../helpers/test-database.js";
import { matchingService } from "../../src/matching/matching-service.js";
import { settlementQueue } from "../../src/services/settlement-queue.js";

const userAddress = testUtils.generateStellarAddress("GUSER");
const makerAddress = testUtils.generateStellarAddress("GMAKER");

// ---------------------------------------------------------------------------
// Acceptance criteria: creation, validation, persistence, listing
// ---------------------------------------------------------------------------

describe("POST /v1/orders — creation, validation, DB persistence", () => {
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

  it("returns 201 with order.id and status: OPEN for a valid payload on an ACTIVE market", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 10,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(typeof body.order.id).toBe("string");
    expect(body.order.status).toBe("OPEN");
    expect(body.order.marketId).toBe(market.id);
    expect(body.order.userAddress).toBe(userAddress);
    expect(body.order.side).toBe("BUY");
    expect(body.order.outcome).toBe("YES");
    expect(body.order.quantity).toBe(10);
    expect(body.filledQuantity).toBe(0);
    expect(Array.isArray(body.trades)).toBe(true);
  });

  it("persists the created order to the DB with correct fields", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "SELL",
        outcome: "NO",
        price: 0.3,
        quantity: 5,
      },
    });

    expect(res.statusCode).toBe(201);
    const { order } = JSON.parse(res.body);

    const row = await prisma.order.findUnique({ where: { id: order.id } });
    expect(row).not.toBeNull();
    expect(row?.marketId).toBe(market.id);
    expect(row?.userAddress).toBe(userAddress);
    expect(row?.side).toBe("SELL");
    expect(row?.outcome).toBe("NO");
    expect(Number(row?.price)).toBeCloseTo(0.3);
    expect(row?.quantity).toBe(5);
    expect(row?.filledQuantity).toBe(0);
    expect(row?.status).toBe("OPEN");
  });

  it("serializes price as a decimal string in the response", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.25,
        quantity: 1,
      },
    });

    expect(res.statusCode).toBe(201);
    const { order } = JSON.parse(res.body);
    // Price must be serialized as a string (Decimal type from Prisma)
    expect(typeof order.price).toBe("string");
    expect(parseFloat(order.price)).toBeCloseTo(0.25);
  });

  it("returns 400 for a non-existent market", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: "00000000-0000-0000-0000-000000000000",
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 1,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for a CANCELLED market", async () => {
    const market = await testUtils.createTestMarket({ status: "CANCELLED" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 1,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for price = 0", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0,
        quantity: 1,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for price = 1", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 1,
        quantity: 1,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for an invalid Stellar address", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress: "not-a-stellar-address",
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 1,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for quantity = 0", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 0,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when a required field is missing", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        // outcome missing
        price: 0.5,
        quantity: 1,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria: GET /orders/user/:address listing + status filter
// ---------------------------------------------------------------------------

describe("GET /v1/orders/user/:address — listing and status filter", () => {
  let app: FastifyInstance;

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

  it("returns the created order after POST", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 7,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/orders/user/${userAddress}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.orders)).toBe(true);
    expect(body.orders.length).toBeGreaterThanOrEqual(1);
    expect(body.orders[0].marketId).toBe(market.id);
  });

  it("?status=OPEN filter works end-to-end", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const prisma = getTestPrismaClient();

    // Create one OPEN and one CANCELLED order directly in DB
    await testUtils.createTestOrder(market.id, userAddress, {
      status: "OPEN",
      price: 0.4,
      quantity: 3,
    });
    await testUtils.createTestOrder(market.id, userAddress, {
      status: "CANCELLED",
      price: 0.6,
      quantity: 2,
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/orders/user/${userAddress}?status=OPEN`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.orders.every((o: any) => o.status === "OPEN")).toBe(true);
  });

  it("returns 400 for an invalid Stellar address", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/orders/user/bad-address",
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Matching engine tests (preserved from original orders.test.ts)
// ---------------------------------------------------------------------------

describe("Integration Tests: POST /v1/orders with Matching", () => {
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

  it("should match two crossing orders and return both FILLED", async () => {
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

    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.order.status).toBe("FILLED");
    expect(body.order.filledQuantity).toBe(100);
    expect(body.filledQuantity).toBe(100);
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].price).toBe(0.5);
    expect(body.trades[0].quantity).toBe(100);
    expect(body.trades[0].buyOrderId).toBe(body.order.id);
    expect(body.trades[0].sellOrderId).toBe(makerOrder.id);

    const makerInDb = await prisma.order.findUnique({
      where: { id: makerOrder.id },
    });
    expect(makerInDb?.status).toBe("FILLED");
    expect(makerInDb?.filledQuantity).toBe(100);
    expect(settlementQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("should create PARTIALLY_FILLED orders on partial match", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

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

    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.order.status).toBe("PARTIALLY_FILLED");
    expect(body.order.filledQuantity).toBe(50);
    expect(body.filledQuantity).toBe(50);
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].quantity).toBe(50);

    const makerInDb = await prisma.order.findUnique({
      where: { id: makerOrder.id },
    });
    expect(makerInDb?.status).toBe("FILLED");

    const takerInDb = await prisma.order.findUnique({
      where: { id: body.order.id },
    });
    expect(takerInDb?.status).toBe("PARTIALLY_FILLED");
    expect(takerInDb?.filledQuantity).toBe(50);
  });

  it("should create OPEN order when no match found", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
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

    const ordersResponse = await app.inject({
      method: "GET",
      url: `/v1/orders/user/${userAddress}`,
    });
    expect(ordersResponse.statusCode).toBe(200);
    const ordersBody = JSON.parse(ordersResponse.body);
    expect(ordersBody.orders).toHaveLength(1);
    expect(ordersBody.orders[0].status).toBe("OPEN");
  });

  it("should update UserPosition after match", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
    });

    await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
      },
    });

    const takerPos = await prisma.userPosition.findUnique({
      where: { marketId_userAddress: { marketId: market.id, userAddress } },
    });
    expect(takerPos?.yesShares).toBe(100);
    expect(takerPos?.noShares).toBe(0);

    const makerPos = await prisma.userPosition.findUnique({
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

    await testUtils.createTestOrder(market.id, userAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
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

    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
    });

    await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
      },
    });

    expect(settlementQueue.enqueue).toHaveBeenCalledTimes(1);
    const call = (settlementQueue.enqueue as any).mock.calls[0][0];
    expect(call.marketId).toBe(market.id);
    expect(call.outcome).toBe("YES");
    expect(call.quantity).toBe(100);
    expect(call.price).toBe(0.5);
  });

  it("should serialize concurrent orders to same market", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    const [response1, response2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/orders",
        payload: {
          marketId: market.id,
          userAddress,
          side: "BUY",
          outcome: "YES",
          price: 0.3,
          quantity: 50,
        },
      }),
      app.inject({
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
      }),
    ]);

    expect(response1.statusCode).toBe(201);
    expect(response2.statusCode).toBe(201);
    expect(JSON.parse(response1.body).order.status).toBe("OPEN");
    expect(JSON.parse(response2.body).order.status).toBe("OPEN");

    const orders = await prisma.order.findMany({
      where: { marketId: market.id },
    });
    expect(orders).toHaveLength(2);
  });

  it("should rebuild book from DB on restart (simulated)", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });

    await testUtils.createTestOrder(market.id, makerAddress, {
      side: "SELL",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
    });

    (matchingService as any).books?.clear();

    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.trades).toHaveLength(1);
    expect(body.order.status).toBe("FILLED");
  });
});
