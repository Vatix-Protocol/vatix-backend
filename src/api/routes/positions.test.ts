import { describe, it, expect, vi } from "vitest";
import fastify from "fastify";
import positionsRouter from "./positions";
import { errorHandler } from "../middleware/errorHandler";

// Default mock: one open position, one settled position
const mockPositions = [
  {
    id: "test-pos-1",
    userAddress: "GBAHUIO7S6NXF2654321098765432109876543210987654321098765",
    marketId: "market-1",
    yesShares: 50,
    noShares: 10,
    lockedCollateral: { toString: () => "25.50000000" },
    isSettled: false,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    market: {
      id: "market-1",
      question: "Will it rain?",
      outcome: null,
      status: "ACTIVE",
    },
  },
  {
    id: "test-pos-2",
    userAddress: "GBAHUIO7S6NXF2654321098765432109876543210987654321098765",
    marketId: "market-2",
    yesShares: 100,
    noShares: 0,
    lockedCollateral: { toString: () => "60.00000000" },
    isSettled: true,
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    market: {
      id: "market-2",
      question: "Will it snow?",
      outcome: true, // YES won
      status: "RESOLVED",
    },
  },
];

// Default order mock: YES ask=0.6, bid=0.5 for market-1 → mid=0.55
const mockOrderGroupBy = [
  {
    marketId: "market-1",
    side: "SELL",
    _min: { price: "0.60000000" },
    _max: { price: null },
  },
  {
    marketId: "market-1",
    side: "BUY",
    _min: { price: null },
    _max: { price: "0.50000000" },
  },
];

vi.mock("../../services/prisma", () => ({
  getPrismaClient: () => ({
    userPosition: {
      findMany: vi.fn().mockResolvedValue(mockPositions),
    },
    order: {
      groupBy: vi.fn().mockResolvedValue(mockOrderGroupBy),
    },
    $disconnect: vi.fn(),
  }),
  disconnectPrisma: vi.fn(),
}));

vi.mock("../../matching/validation", () => ({
  validateUserAddress: (addr: string) =>
    /^G[A-Z2-7]{55}$/.test(addr) ? null : "Invalid Stellar address",
  STELLAR_PUBLIC_KEY_REGEX: /^G[A-Z2-7]{55}$/,
}));

vi.mock("../middleware/rateLimiter", () => ({
  heavyReadLimiter: async () => {},
}));

describe("Positions Route", () => {
  const createTestServer = async () => {
    const app = fastify();
    app.setErrorHandler(errorHandler);
    await app.register(positionsRouter);
    return app;
  };

  it("should return 400 for invalid address on legacy endpoint", async () => {
    const app = await createTestServer();
    const response = await app.inject({
      method: "GET",
      url: "/positions/user/0xInvalidAddress",
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("Invalid Stellar address");
  });

  it("should return 200 and calculate correct payout structure on legacy endpoint", async () => {
    const app = await createTestServer();
    const validAddress =
      "GBAHUIO7S6NXF2654321098765432109876543210987654321098765";
    const response = await app.inject({
      method: "GET",
      url: `/positions/user/${validAddress}`,
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].potentialPayoutIfYes).toBe(50);
    expect(body[0].potentialPayoutIfNo).toBe(10);
    expect(body[0].netPosition).toBe(40);
    expect(body[0].market.question).toBe("Will it rain?");
  });

  it("should return wallet exposure rows with standardized success response", async () => {
    const app = await createTestServer();
    const wallet = "GBAHUIO7S6NXF2654321098765432109876543210987654321098765";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions`,
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.wallet).toBe(wallet);
    expect(body.data.count).toBe(2);
    expect(body.data.exposures[0]).toMatchObject({
      marketId: "market-1",
      marketQuestion: "Will it rain?",
      yesShares: 50,
      noShares: 10,
      netExposure: 40,
      lockedCollateral: "25.50000000",
      isSettled: false,
    });
  });

  it("should include pnlRealized on settled positions", async () => {
    const app = await createTestServer();
    const wallet = "GBAHUIO7S6NXF2654321098765432109876543210987654321098765";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions`,
    });
    const { data } = JSON.parse(response.body);

    // market-2: YES won, 100 yes shares, cost=60 → pnl = 100 - 60 = 40.00000000
    const settled = data.exposures.find((e: any) => e.marketId === "market-2");
    expect(settled.pnlRealized).toBe("40.00000000");
    expect(settled.pnlUnrealized).toBeNull();
  });

  it("should include pnlUnrealized on open positions using mid-price", async () => {
    const app = await createTestServer();
    const wallet = "GBAHUIO7S6NXF2654321098765432109876543210987654321098765";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions`,
    });
    const { data } = JSON.parse(response.body);

    // market-1: mid=0.55, yes=50, no=10, cost=25.5
    // markValue = 50*0.55 + 10*0.45 = 27.5 + 4.5 = 32.0
    // pnlUnrealized = 32.0 - 25.5 = 6.5 → "6.50000000"
    const open = data.exposures.find((e: any) => e.marketId === "market-1");
    expect(open.pnlUnrealized).toBe("6.50000000");
    expect(open.pnlRealized).toBeNull();
  });

  it("should return correct pnlTotal, pnlRealized, pnlUnrealized summary", async () => {
    const app = await createTestServer();
    const wallet = "GBAHUIO7S6NXF2654321098765432109876543210987654321098765";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions`,
    });
    const { data } = JSON.parse(response.body);

    // realized=40, unrealized=6.5, total=46.5
    expect(data.pnlRealized).toBe("40.00000000");
    expect(data.pnlUnrealized).toBe("6.50000000");
    expect(data.pnlTotal).toBe("46.50000000");
  });

  it("should return 200 with empty list and zero totals for new wallet (empty state)", async () => {
    const { getPrismaClient } = await import("../../services/prisma");
    const prisma = getPrismaClient() as any;
    prisma.userPosition.findMany.mockResolvedValueOnce([]);
    prisma.order.groupBy.mockResolvedValueOnce([]);

    const app = await createTestServer();
    const wallet = "GBAHUIO7S6NXF2654321098765432109876543210987654321098765";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.count).toBe(0);
    expect(body.data.exposures).toEqual([]);
    expect(body.data.pnlRealized).toBe("0.00000000");
    expect(body.data.pnlUnrealized).toBe("0.00000000");
    expect(body.data.pnlTotal).toBe("0.00000000");
  });

  it("should return null pnlUnrealized when no open orders exist to price position", async () => {
    const { getPrismaClient } = await import("../../services/prisma");
    const prisma = getPrismaClient() as any;
    prisma.userPosition.findMany.mockResolvedValueOnce([mockPositions[0]]);
    prisma.order.groupBy.mockResolvedValueOnce([]); // no orders

    const app = await createTestServer();
    const wallet = "GBAHUIO7S6NXF2654321098765432109876543210987654321098765";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions`,
    });

    const { data } = JSON.parse(response.body);
    expect(data.exposures[0].pnlUnrealized).toBeNull();
    expect(data.pnlUnrealized).toBe("0.00000000");
  });

  it("should return 400 for invalid wallet identifier on wallet exposure endpoint", async () => {
    const app = await createTestServer();
    const response = await app.inject({
      method: "GET",
      url: "/wallets/0xInvalidAddress/positions",
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("params/wallet");
  });

  it("should return 400 for wallet with non-Stellar base32 characters", async () => {
    const app = await createTestServer();
    const invalidWallet =
      "G1BCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${invalidWallet}/positions`,
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("params/wallet");
  });
});
