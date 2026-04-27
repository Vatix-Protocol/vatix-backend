import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { ordersRoutes } from "./orders.js";
import { errorHandler } from "../middleware/errorHandler.js";
import type { PrismaClient } from "../../generated/prisma/client";

const mockPrismaClient = {
  order: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
  market: {
    findUnique: vi.fn(),
  },
} as unknown as PrismaClient;

vi.mock("../../services/prisma.js", () => ({
  getPrismaClient: () => mockPrismaClient,
}));

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

    const response = await app.inject({
      method: "GET",
      url: `/orders/user/${validAddress}`,
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.orders).toHaveLength(2);
    expect(body.count).toBe(2);
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
      orderBy: { createdAt: "desc" },
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
    expect(body.count).toBe(0);
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
