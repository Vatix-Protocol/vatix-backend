import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { buildSignableMessage } from "./stellarAuth.js";
import type { PrismaClient } from "../../generated/prisma/client";

// ---------------------------------------------------------------------------
// Module-level mocks required by ordersRoutes
// ---------------------------------------------------------------------------

const { mockPrismaClient, mockMatchingService } = vi.hoisted(() => ({
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
  },
}));

vi.mock("../../services/prisma.js", () => ({
  getPrismaClient: () => mockPrismaClient,
}));

vi.mock("../../services/audit.js", () => ({
  auditService: { getWalletTradeHistory: vi.fn() },
}));

vi.mock("../../matching/matching-service.js", () => ({
  matchingService: mockMatchingService,
}));

// Import AFTER mocks are registered
import { ordersRoutes } from "../routes/orders.js";
import { errorHandler } from "./errorHandler.js";
import { clearRateLimitStores } from "./rateLimiter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validMarket = {
  id: "market-1",
  question: "Will it rain tomorrow?",
  status: "ACTIVE",
  endTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeHeaders(
  keypair: Keypair,
  body: {
    marketId: string;
    userAddress: string;
    side: string;
    outcome: string;
    price: number;
    quantity: number;
  },
  ts = Date.now()
): Record<string, string> {
  const sig = keypair
    .sign(buildSignableMessage({ ...body, timestamp: ts }))
    .toString("base64");
  return {
    "x-signature": sig,
    "x-timestamp": String(ts),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /orders – Stellar wallet signature verification", () => {
  let app: FastifyInstance;
  const testKeypair = Keypair.random();
  const userAddress = testKeypair.publicKey();

  const validBody = {
    marketId: "market-1",
    userAddress,
    side: "BUY",
    outcome: "YES",
    price: 0.6,
    quantity: 100,
  };

  beforeEach(async () => {
    clearRateLimitStores();
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(ordersRoutes);
    vi.clearAllMocks();

    (
      mockPrismaClient.market.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue(validMarket);

    (
      mockMatchingService.placeOrder as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      order: {
        ...validBody,
        id: "order-1",
        price: "0.6",
        filledQuantity: 0,
        status: "OPEN",
        createdAt: new Date(),
      },
      trades: [],
      filledQuantity: 0,
    });
  });

  afterEach(async () => {
    await app.close();
    clearRateLimitStores();
  });

  it("should accept an order signed with the correct wallet keypair", async () => {
    const ts = Date.now();
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      headers: makeHeaders(testKeypair, validBody, ts),
      payload: validBody,
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.order).toBeDefined();
  });

  it("should return 401 when x-signature header is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "x-timestamp": String(Date.now()) },
      payload: validBody,
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("x-signature");
  });

  it("should return 401 when x-timestamp header is missing", async () => {
    const ts = Date.now();
    const sig = testKeypair
      .sign(buildSignableMessage({ ...validBody, timestamp: ts }))
      .toString("base64");

    const response = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "x-signature": sig },
      payload: validBody,
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("x-timestamp");
  });

  it("should return 401 when the signature belongs to a different keypair", async () => {
    const otherKeypair = Keypair.random();
    const ts = Date.now();
    const wrongSig = otherKeypair
      .sign(buildSignableMessage({ ...validBody, timestamp: ts }))
      .toString("base64");

    const response = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        "x-signature": wrongSig,
        "x-timestamp": String(ts),
      },
      payload: validBody,
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("Signature verification failed");
  });

  it("should return 401 when the timestamp is expired (> 5 minutes old)", async () => {
    const oldTs = Date.now() - 6 * 60 * 1000; // 6 minutes ago
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      headers: makeHeaders(testKeypair, validBody, oldTs),
      payload: validBody,
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("expired");
  });

  it("should return 401 when the signature covers different body fields", async () => {
    const ts = Date.now();
    // Sign a body with a different price than what is actually sent
    const tamperedBody = { ...validBody, price: 0.1 };
    const sig = testKeypair
      .sign(buildSignableMessage({ ...tamperedBody, timestamp: ts }))
      .toString("base64");

    const response = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        "x-signature": sig,
        "x-timestamp": String(ts),
      },
      payload: validBody, // original body – signature mismatch
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("Signature verification failed");
  });

  it("should return 401 when userAddress is not a valid Stellar public key", async () => {
    const ts = Date.now();
    const invalidBody = { ...validBody, userAddress: "not-a-stellar-address" };
    const sig = testKeypair
      .sign(buildSignableMessage({ ...invalidBody, timestamp: ts }))
      .toString("base64");

    const response = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        "x-signature": sig,
        "x-timestamp": String(ts),
      },
      payload: invalidBody,
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("Invalid signature or userAddress");
  });

  it("should return 401 for a malformed (non-base64) signature", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        "x-signature": "!!!not-valid-base64!!!",
        "x-timestamp": String(Date.now()),
      },
      payload: validBody,
    });

    expect(response.statusCode).toBe(401);
  });
});
