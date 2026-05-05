import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { ordersRoutes } from "./orders.js";
import { errorHandler } from "../middleware/errorHandler.js";
import type { PrismaClient } from "../../generated/prisma/client";

const { mockAuditService, mockPrismaClient } = vi.hoisted(() => ({
  mockAuditService: {
    getWalletTradeHistory: vi.fn(),
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
}));

vi.mock("../../services/prisma.js", () => ({
  getPrismaClient: () => mockPrismaClient,
}));

vi.mock("../../services/audit.js", () => ({
  auditService: mockAuditService,
}));

describe("GET /trades/user/:address", () => {
  let app: FastifyInstance;
  const validAddress =
    "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(ordersRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
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
    expect(body.trades[1].id).toBe("trade-1");
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
      Date.parse(to)
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

describe("GET /orders/user/:address", () => {
  let app: FastifyInstance;

  const validAddress =
    "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(ordersRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it("should return user orders sorted by newest first", async () => {
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
    (
      mockPrismaClient.order.count as ReturnType<typeof vi.fn>
    ).mockResolvedValue(2);

    const response = await app.inject({
      method: "GET",
      url: `/orders/user/${validAddress}`,
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.orders).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.hasNext).toBe(false);
    expect(body.orders[0].id).toBe("order-2");
  });

  it("should filter orders by status", async () => {
    (
      mockPrismaClient.order.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([]);
    (
      mockPrismaClient.order.count as ReturnType<typeof vi.fn>
    ).mockResolvedValue(0);

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
      skip: 0,
      take: 20,
    });
  });

  it("should return empty array when user has no orders", async () => {
    (
      mockPrismaClient.order.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([]);
    (
      mockPrismaClient.order.count as ReturnType<typeof vi.fn>
    ).mockResolvedValue(0);

    const response = await app.inject({
      method: "GET",
      url: `/orders/user/${validAddress}`,
    });

    const body = JSON.parse(response.body);
    expect(body.orders).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.hasNext).toBe(false);
  });

  it("should support page and limit pagination with hasNext metadata", async () => {
    (
      mockPrismaClient.order.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      {
        id: "order-3",
        marketId: "market-1",
        userAddress: validAddress,
        side: "BUY",
        outcome: "YES",
        price: "0.55",
        quantity: 10,
        filledQuantity: 0,
        status: "OPEN",
        createdAt: new Date("2026-01-15T00:00:00Z"),
      },
    ]);
    (
      mockPrismaClient.order.count as ReturnType<typeof vi.fn>
    ).mockResolvedValue(5);

    const response = await app.inject({
      method: "GET",
      url: `/orders/user/${validAddress}?page=2&limit=2`,
    });

    expect(response.statusCode).toBe(200);
    expect(mockPrismaClient.order.findMany).toHaveBeenCalledWith({
      where: {
        userAddress: validAddress,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: 2,
      take: 2,
    });

    const body = JSON.parse(response.body);
    expect(body.page).toBe(2);
    expect(body.limit).toBe(2);
    expect(body.total).toBe(5);
    expect(body.hasNext).toBe(true);
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
  });

  const validMarket = {
    id: "market-1",
    question: "Will it rain tomorrow?",
    status: "ACTIVE",
    endTime: new Date(Date.now() + 24 * 60 * 60 * 1000), // Tomorrow
    createdAt: new Date(),
    updatedAt: new Date(),
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

    (
      mockPrismaClient.order.create as ReturnType<typeof vi.fn>
    ).mockResolvedValue(createdOrder);

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

  it("should handle database errors gracefully", async () => {
    (
      mockPrismaClient.order.create as ReturnType<typeof vi.fn>
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
