import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { ordersRoutes } from "./orders.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { ValidationError } from "../middleware/errors.js";
import type { PrismaClient } from "../../generated/prisma/client";
import { clearRateLimitStores } from "../middleware/rateLimiter.js";

const { mockAuditService, mockPrismaClient, mockMatchingService, mockRedis } =
  vi.hoisted(() => ({
    mockAuditService: {
      getWalletTradeHistory: vi.fn(),
      getTradeHistory: vi.fn(),
    },
    mockPrismaClient: {
      order: {
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
      },
      market: {
        findUnique: vi.fn(),
      },
    } as unknown as PrismaClient,
    mockMatchingService: {
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
    },
    mockRedis: {
      get: vi.fn(),
      set: vi.fn(),
      prefixed: vi.fn((key: string) => `vatix:${key}`),
    },
  }));

vi.mock("../../services/prisma.js", () => ({
  getPrismaClient: () => mockPrismaClient,
}));

vi.mock("../../services/audit.js", () => ({
  auditService: mockAuditService,
}));

vi.mock("../../services/redis.js", () => ({
  redis: mockRedis,
}));

vi.mock("../../matching/matching-service.js", () => ({
  matchingService: mockMatchingService,
}));

// Bypasses signature verification so route tests stay focused on business
// logic. Signature-specific behaviour is covered in stellarAuth.test.ts.
vi.mock("../middleware/stellarAuth.js", async () => {
  const actual = await vi.importActual<
    typeof import("../middleware/stellarAuth.js")
  >("../middleware/stellarAuth.js");
  return {
    ...actual,
    verifyStellarSignature: (
      _req: unknown,
      _reply: unknown,
      done: () => void
    ) => done(),
    buildSignableMessage: actual.buildSignableMessage,
  };
});

describe("GET /trades/user/:address", () => {
  let app: FastifyInstance;
  const validAddress =
    "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

  beforeEach(async () => {
    clearRateLimitStores();
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(ordersRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
    clearRateLimitStores();
  });

  it("should return wallet trades latest-first with pagination metadata", async () => {
    (
      mockAuditService.getWalletTradeHistory as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      trades: [
        {
          id: "1714170000002-0",
          trade: {
            id: "trade-2",
            marketId: "market-2",
            outcome: "NO",
            buyerAddress: validAddress,
            sellerAddress:
              "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            buyOrderId: "buy-2",
            sellOrderId: "sell-2",
            price: 0.67,
            quantity: 12,
            timestamp: 1714170000002,
          },
          loggedAt: "2026-04-27T14:00:02.000Z",
        },
        {
          id: "1714170000001-0",
          trade: {
            id: "trade-1",
            marketId: "market-1",
            outcome: "YES",
            buyerAddress:
              "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            sellerAddress: validAddress,
            buyOrderId: "buy-1",
            sellOrderId: "sell-1",
            price: 0.51,
            quantity: 20,
            timestamp: 1714170000001,
          },
          loggedAt: "2026-04-27T14:00:01.000Z",
        },
      ],
      total: 2,
      hasNext: false,
      page: 1,
      limit: 20,
    });

    const response = await app.inject({
      method: "GET",
      url: `/trades/user/${validAddress}`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.trades).toHaveLength(2);
    expect(body.trades[0].id).toBe("trade-2");
    expect(body.trades[0].marketId).toBe("market-2");
    expect(body.trades[0].timestampIso).toBe("2024-04-26T22:20:00.002Z");
    expect(body.trades[1].id).toBe("trade-1");
    expect(body.trades[1].timestampIso).toBe("2024-04-26T22:20:00.001Z");
    expect(body.total).toBe(2);
    expect(body.hasNext).toBe(false);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
  });

  it("should pass pagination args to wallet trade history lookup", async () => {
    (
      mockAuditService.getWalletTradeHistory as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      trades: [],
      total: 3,
      hasNext: true,
      page: 2,
      limit: 1,
    });

    const response = await app.inject({
      method: "GET",
      url: `/trades/user/${validAddress}?page=2&limit=1`,
    });

    expect(response.statusCode).toBe(200);
    expect(mockAuditService.getWalletTradeHistory).toHaveBeenCalledWith(
      validAddress,
      2,
      1,
      undefined,
      undefined,
      undefined
    );
  });

  it("should pass from/to UTC filters to wallet trade history lookup", async () => {
    (
      mockAuditService.getWalletTradeHistory as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      trades: [],
      total: 0,
      hasNext: false,
      page: 1,
      limit: 20,
    });

    const from = "2026-04-27T00:00:00.000Z";
    const to = "2026-04-27T23:59:59.999Z";
    const response = await app.inject({
      method: "GET",
      url: `/trades/user/${validAddress}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(mockAuditService.getWalletTradeHistory).toHaveBeenCalledWith(
      validAddress,
      1,
      20,
      Date.parse(from),
      Date.parse(to),
      undefined
    );
  });

  it("should return 400 when from is after to", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/trades/user/${validAddress}?from=2026-04-28T00:00:00.000Z&to=2026-04-27T00:00:00.000Z`,
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("Invalid date range");
  });

  it("should return 400 for invalid wallet address", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/trades/user/not-a-wallet",
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /trades", () => {
  let app: FastifyInstance;
  const originalCacheEnabled = process.env.TRADES_CACHE_ENABLED;

  beforeEach(async () => {
    clearRateLimitStores();
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(ordersRoutes);
    vi.clearAllMocks();
    delete process.env.TRADES_CACHE_ENABLED;
  });

  afterEach(async () => {
    await app.close();
    clearRateLimitStores();
    if (originalCacheEnabled === undefined) {
      delete process.env.TRADES_CACHE_ENABLED;
    } else {
      process.env.TRADES_CACHE_ENABLED = originalCacheEnabled;
    }
  });

  const sampleHistory = {
    trades: [
      {
        id: "1714170000002-0",
        trade: {
          id: "trade-2",
          marketId: "market-2",
          outcome: "NO",
          buyerAddress:
            "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW",
          sellerAddress:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          buyOrderId: "buy-2",
          sellOrderId: "sell-2",
          price: 0.67,
          quantity: 12,
          timestamp: 1714170000002,
        },
        loggedAt: "2026-04-27T14:00:02.000Z",
      },
    ],
    total: 1,
    hasNext: false,
    page: 1,
    limit: 20,
  };

  it("should return global trade listing with pagination metadata", async () => {
    (
      mockAuditService.getTradeHistory as ReturnType<typeof vi.fn>
    ).mockResolvedValue(sampleHistory);

    const response = await app.inject({ method: "GET", url: "/trades" });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].id).toBe("trade-2");
    expect(body.total).toBe(1);
    expect(body.hasNext).toBe(false);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
    expect(mockAuditService.getTradeHistory).toHaveBeenCalledWith(
      1,
      20,
      undefined,
      undefined,
      undefined
    );
  });

  it("should pass page/limit/marketId/from/to filters through", async () => {
    (
      mockAuditService.getTradeHistory as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ ...sampleHistory, page: 2, limit: 5 });

    const from = "2026-04-27T00:00:00.000Z";
    const to = "2026-04-27T23:59:59.999Z";

    const response = await app.inject({
      method: "GET",
      url: `/trades?page=2&limit=5&marketId=market-2&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(mockAuditService.getTradeHistory).toHaveBeenCalledWith(
      2,
      5,
      Date.parse(from),
      Date.parse(to),
      "market-2"
    );
  });

  it("should return 400 when from is after to", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/trades?from=2026-04-28T00:00:00.000Z&to=2026-04-27T00:00:00.000Z",
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("Invalid date range");
  });

  it("should not read or write the Redis cache when TRADES_CACHE_ENABLED is unset", async () => {
    (
      mockAuditService.getTradeHistory as ReturnType<typeof vi.fn>
    ).mockResolvedValue(sampleHistory);

    const response = await app.inject({ method: "GET", url: "/trades" });

    expect(response.statusCode).toBe(200);
    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it("should serve from Redis cache on a hit when TRADES_CACHE_ENABLED=true", async () => {
    process.env.TRADES_CACHE_ENABLED = "true";
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify(sampleHistory)
    );

    const response = await app.inject({ method: "GET", url: "/trades" });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual(sampleHistory);
    expect(mockAuditService.getTradeHistory).not.toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it("should query Postgres and populate the cache on a miss when TRADES_CACHE_ENABLED=true", async () => {
    process.env.TRADES_CACHE_ENABLED = "true";
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (
      mockAuditService.getTradeHistory as ReturnType<typeof vi.fn>
    ).mockResolvedValue(sampleHistory);

    const response = await app.inject({ method: "GET", url: "/trades" });

    expect(response.statusCode).toBe(200);
    expect(mockAuditService.getTradeHistory).toHaveBeenCalled();
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Number)
    );
  });

  it("should fall back to Postgres when Redis read fails", async () => {
    process.env.TRADES_CACHE_ENABLED = "true";
    (mockRedis.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connection refused")
    );
    (
      mockAuditService.getTradeHistory as ReturnType<typeof vi.fn>
    ).mockResolvedValue(sampleHistory);

    const response = await app.inject({ method: "GET", url: "/trades" });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.trades).toHaveLength(1);
    expect(mockAuditService.getTradeHistory).toHaveBeenCalled();
  });
});

describe("GET /orders/user/:address", () => {
  let app: FastifyInstance;

  const validAddress =
    "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

  beforeEach(async () => {
    clearRateLimitStores();
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(ordersRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
    clearRateLimitStores();
  });

  it("should return user orders sorted by newest first with no next cursor", async () => {
    const mockOrders = [
      {
        id: "order-2",
        marketId: "market-1",
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: "0.6",
        quantity: 100,
        filledQuantity: 0,
        status: "OPEN",
        createdAt: new Date("2026-01-20T00:00:00Z"),
      },
      {
        id: "order-1",
        marketId: "market-1",
        userAddress: validAddress,
        side: "SELL",
        outcome: "NO",
        price: "0.5",
        quantity: 50,
        filledQuantity: 50,
        status: "FILLED",
        createdAt: new Date("2026-01-10T00:00:00Z"),
      },
    ];

    (
      mockPrismaClient.order.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue(mockOrders);

    const response = await app.inject({
      method: "GET",
      url: `/orders/user/${validAddress}`,
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.orders).toHaveLength(2);
    expect(body.hasNext).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.orders[0].id).toBe("order-2");
  });

  it("should filter orders by status", async () => {
    (
      mockPrismaClient.order.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([]);

    const response = await app.inject({
      method: "GET",
      url: `/orders/user/${validAddress}?status=OPEN`,
    });

    expect(response.statusCode).toBe(200);

    expect(mockPrismaClient.order.findMany).toHaveBeenCalledWith({
      where: {
        userAddress: validAddress,
        status: "OPEN",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 21,
    });
  });

  it("should return empty array when user has no orders", async () => {
    (
      mockPrismaClient.order.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([]);

    const response = await app.inject({
      method: "GET",
      url: `/orders/user/${validAddress}`,
    });

    const body = JSON.parse(response.body);
    expect(body.orders).toEqual([]);
    expect(body.hasNext).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("should return nextCursor and hasNext=true when more items exist", async () => {
    const limit = 2;
    // limit+1 items returned signals another page exists
    const mockOrders = Array.from({ length: limit + 1 }, (_, i) => ({
      id: `order-${i + 1}`,
      marketId: "market-1",
      userAddress: validAddress,
      side: "BUY",
      outcome: "YES",
      price: "0.5",
      quantity: 10,
      filledQuantity: 0,
      status: "OPEN",
      createdAt: new Date(`2026-01-0${i + 1}T00:00:00Z`),
    }));

    (
      mockPrismaClient.order.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue(mockOrders);

    const response = await app.inject({
      method: "GET",
      url: `/orders/user/${validAddress}?limit=2`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.orders).toHaveLength(2);
    expect(body.hasNext).toBe(true);
    expect(typeof body.nextCursor).toBe("string");
    expect(body.limit).toBe(2);
  });

  it("should return 400 for an invalid cursor", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/orders/user/${validAddress}?cursor=!!!notvalidbase64!!!`,
    });

    expect(response.statusCode).toBe(400);
  });

  it("should use a valid cursor to fetch the next page", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: "2026-01-15T00:00:00.000Z", id: "order-2" })
    ).toString("base64url");

    (
      mockPrismaClient.order.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([]);

    const response = await app.inject({
      method: "GET",
      url: `/orders/user/${validAddress}?cursor=${cursor}`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.orders).toEqual([]);
    expect(body.hasNext).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("should reject invalid Stellar address", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/orders/user/invalid-address`,
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject invalid status value", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/orders/user/${validAddress}?status=INVALID`,
    });

    expect(response.statusCode).toBe(400);
  });

  it("should return 500 when database error occurs", async () => {
    (
      mockPrismaClient.order.findMany as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("Database connection failed"));
    (
      mockPrismaClient.order.count as ReturnType<typeof vi.fn>
    ).mockResolvedValue(0);

    const response = await app.inject({
      method: "GET",
      url: `/orders/user/${validAddress}`,
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("error");
  });
});

describe("POST /orders", () => {
  let app: FastifyInstance;
  const validAddress =
    "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

  beforeEach(async () => {
    clearRateLimitStores();
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(ordersRoutes);
    vi.clearAllMocks();

    // Mock market exists and is active
    (
      mockPrismaClient.market.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      id: "market-1",
      question: "Will it rain tomorrow?",
      status: "ACTIVE",
      endTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(async () => {
    await app.close();
    clearRateLimitStores();
  });

  const validMarket = {
    id: "market-1",
    question: "Will it rain tomorrow?",
    status: "ACTIVE",
    endTime: new Date(Date.now() + 24 * 60 * 60 * 1000), // Tomorrow
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  it("should create a valid order", async () => {
    const newOrder = {
      marketId: "market-1",
      userAddress: validAddress,
      side: "BUY" as const,
      outcome: "YES" as const,
      price: 0.6,
      quantity: 100,
    };

    const createdOrder = {
      id: "order-123",
      ...newOrder,
      price: "0.6",
      filledQuantity: 0,
      status: "OPEN",
      createdAt: new Date(),
    };

    // Mock market for validation
    (
      mockPrismaClient.market.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue(validMarket);

    (
      mockMatchingService.placeOrder as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      order: createdOrder,
      trades: [],
      filledQuantity: 0,
    });

    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: newOrder,
    });

    expect(response.statusCode).toBe(201);

    const body = JSON.parse(response.body);
    expect(body.order).toBeDefined();
    expect(body.order.id).toBe("order-123");
    expect(body.order.side).toBe("BUY");
    expect(body.order.status).toBe("OPEN");
    expect(body.trades).toEqual([]);
    expect(body.filledQuantity).toBe(0);
  });

  it("should return 429 with RATE_LIMITED body once the write limit is exceeded", async () => {
    (
      mockPrismaClient.market.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue(validMarket);
    (
      mockMatchingService.placeOrder as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      order: { id: "order-1", status: "OPEN" },
      trades: [],
      filledQuantity: 0,
    });

    const newOrder = {
      marketId: "market-1",
      userAddress: validAddress,
      side: "BUY" as const,
      outcome: "YES" as const,
      price: 0.6,
      quantity: 100,
    };

    // Default write tier allows 10 req/min (see RATE_LIMIT_POLICY.md); the
    // 11th request in the same window must be rejected.
    let last;
    for (let i = 0; i < 11; i++) {
      last = await app.inject({
        method: "POST",
        url: "/orders",
        payload: newOrder,
      });
    }

    expect(last!.statusCode).toBe(429);
    expect(last!.headers["retry-after"]).toBeDefined();
    const body = JSON.parse(last!.body);
    expect(body).toMatchObject({
      error: "Too Many Requests",
      code: "RATE_LIMITED",
      statusCode: 429,
    });
  });

  it("normalizes trade timestamps to ISO-8601 in the response", async () => {
    const newOrder = {
      marketId: "market-1",
      userAddress: validAddress,
      side: "BUY" as const,
      outcome: "YES" as const,
      price: 0.6,
      quantity: 100,
    };

    (
      mockPrismaClient.market.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue(validMarket);

    (
      mockMatchingService.placeOrder as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      order: {
        id: "order-123",
        ...newOrder,
        price: "0.6",
        filledQuantity: 100,
        status: "FILLED",
        createdAt: new Date(),
      },
      trades: [
        {
          id: "trade-1",
          marketId: "market-1",
          outcome: "YES",
          buyerAddress: validAddress,
          sellerAddress:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          buyOrderId: "order-123",
          sellOrderId: "order-456",
          price: 0.6,
          quantity: 100,
          timestamp: 1714170000002,
          timestampIso: "2024-04-26T22:20:00.002Z",
        },
      ],
      filledQuantity: 100,
    });

    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: newOrder,
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.trades[0].timestamp).toBe(1714170000002);
    expect(body.trades[0].timestampIso).toBe("2024-04-26T22:20:00.002Z");
  });

  it("should reject order with invalid Stellar address", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "market-1",
        userAddress: "invalid-address",
        side: "BUY",
        outcome: "YES",
        price: 0.6,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("address");
  });

  it("should reject order with invalid price (> 1)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "market-1",
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 1.5,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject order with price = 0", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "market-1",
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject order with price = 1", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "market-1",
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 1,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject order with zero quantity", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "market-1",
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.6,
        quantity: 0,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject order with negative quantity", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "market-1",
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.6,
        quantity: -10,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject order with invalid side", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "market-1",
        userAddress: validAddress,
        side: "HOLD",
        outcome: "YES",
        price: 0.6,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject order with invalid outcome", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "market-1",
        userAddress: validAddress,
        side: "BUY",
        outcome: "MAYBE",
        price: 0.6,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject order for non-existent market", async () => {
    (
      mockPrismaClient.market.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "non-existent",
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.6,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("Market not found");
  });

  it("should reject order for closed market", async () => {
    (
      mockPrismaClient.market.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      ...validMarket,
      status: "RESOLVED",
    });

    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "market-1",
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.6,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("Market is resolved");
  });

  it("should reject order for expired market", async () => {
    (
      mockPrismaClient.market.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      ...validMarket,
      endTime: new Date(Date.now() - 1000), // Expired
    });

    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "market-1",
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.6,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("Market has ended");
  });

  it("should handle missing required fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "market-1",
        // Missing other required fields
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject invalid input before creating a Prisma order", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "market-1",
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: "not-a-number",
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(mockPrismaClient.order.create).not.toHaveBeenCalled();
  });

  it("should handle database errors gracefully", async () => {
    // Mock market for validation
    (
      mockPrismaClient.market.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue(validMarket);

    (
      mockMatchingService.placeOrder as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("Database error"));

    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        marketId: "market-1",
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.6,
        quantity: 100,
      },
    });

    expect(response.statusCode).toBe(500);
  });
});

describe("DELETE /orders/:id — cancel order", () => {
  let app: FastifyInstance;
  const testKeypair = Keypair.random();
  const userAddress = testKeypair.publicKey();
  const validAddress =
    "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
  const NONCE = "test-nonce";

  function makeCancellationHeaders(
    keypair: Keypair,
    orderId: string,
    address: string,
    ts = Date.now()
  ): Record<string, string> {
    const { buildCancellationMessage } = require("./middleware/stellarAuth.js");
    const sig = keypair
      .sign(
        buildCancellationMessage({
          orderId,
          nonce: NONCE,
          timestamp: ts,
          userAddress: address,
        })
      )
      .toString("base64");
    return {
      "x-signature": sig,
      "x-timestamp": String(ts),
      "x-nonce": NONCE,
    };
  }

  beforeEach(async () => {
    clearRateLimitStores();
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(ordersRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
    clearRateLimitStores();
  });

  it("should cancel an open order with valid signature and return 200", async () => {
    const orderId = "order-123";
    const cancelledOrder = {
      id: orderId,
      marketId: "market-1",
      userAddress,
      side: "BUY",
      outcome: "YES",
      price: "0.5",
      quantity: 100,
      filledQuantity: 0,
      status: "CANCELLED",
      createdAt: new Date().toISOString(),
    };

    (
      mockMatchingService.cancelOrder as ReturnType<typeof vi.fn>
    ).mockResolvedValue(cancelledOrder);

    const response = await app.inject({
      method: "DELETE",
      url: `/orders/${orderId}`,
      headers: makeCancellationHeaders(testKeypair, orderId, userAddress),
      payload: { userAddress },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.order.status).toBe("CANCELLED");
    expect(body.order.id).toBe("order-123");
  });

  it("should return 401 when x-signature header is missing", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/orders/order-123",
      headers: { "x-timestamp": String(Date.now()), "x-nonce": NONCE },
      payload: { userAddress },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("x-signature");
  });

  it("should return 401 when signature does not match actual orderId", async () => {
    const orderId = "order-123";
    const wrongOrderId = "order-456";
    const ts = Date.now();
    const sig = testKeypair
      .sign(
        require("./middleware/stellarAuth.js").buildCancellationMessage({
          orderId: wrongOrderId, // Sign for wrong order
          nonce: NONCE,
          timestamp: ts,
          userAddress,
        })
      )
      .toString("base64");

    const response = await app.inject({
      method: "DELETE",
      url: `/orders/${orderId}`,
      headers: {
        "x-signature": sig,
        "x-timestamp": String(ts),
        "x-nonce": NONCE,
      },
      payload: { userAddress },
    });

    expect(response.statusCode).toBe(401);
  });

  it("should return 401 when signature is from different keypair", async () => {
    const otherKeypair = Keypair.random();
    const orderId = "order-123";
    const headers = makeCancellationHeaders(
      otherKeypair,
      orderId,
      otherKeypair.publicKey()
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/orders/${orderId}`,
      headers,
      payload: { userAddress: otherKeypair.publicKey() },
    });

    expect(response.statusCode).toBe(401);
  });

  it("should return 401 when userAddress in body does not match signature", async () => {
    const orderId = "order-123";
    const ts = Date.now();
    // Sign with testKeypair's address but send different userAddress in body
    const headers = makeCancellationHeaders(
      testKeypair,
      orderId,
      userAddress,
      ts
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/orders/${orderId}`,
      headers,
      payload: { userAddress: validAddress }, // Different from signed address
    });

    expect(response.statusCode).toBe(401);
  });

  it("should return 400 when userAddress is missing from request body", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/orders/order-123",
      headers: { "x-timestamp": String(Date.now()), "x-nonce": NONCE },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it("should return 401 when timestamp is expired", async () => {
    const orderId = "order-123";
    const oldTs = Date.now() - 6 * 60 * 1000; // 6 minutes ago
    const headers = makeCancellationHeaders(
      testKeypair,
      orderId,
      userAddress,
      oldTs
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/orders/${orderId}`,
      headers,
      payload: { userAddress },
    });

    expect(response.statusCode).toBe(401);
  });
});
