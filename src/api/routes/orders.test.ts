import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { ordersRoutes } from "./orders.js";
import { errorHandler } from "../middleware/errorHandler.js";
import type { PrismaClient } from "../../generated/prisma/client";

const mockPrismaClient = {
  order: {
    findMany: vi.fn(),
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
    (mockPrismaClient.order.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Database connection failed"),
    );

    const response = await app.inject({
      method: "GET",
      url: `/orders/user/${validAddress}`,
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("error");
  });
});
