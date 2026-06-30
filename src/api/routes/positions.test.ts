import { describe, it, expect, vi } from "vitest";
import fastify from "fastify";
import positionsRouter from "./positions";
import { errorHandler } from "../middleware/errorHandler";

// Default mock: one open position, one settled position
const mockPositions = [
  {
    id: "test-pos-1",
    userAddress: "GINJ46CDSMNOSKETX3K5DU44435TGRWIQEM7ZVI3ON3BTOOFVJJHTWXO",
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
    userAddress: "GINJ46CDSMNOSKETX3K5DU44435TGRWIQEM7ZVI3ON3BTOOFVJJHTWXO",
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

const mockPrisma = {
  userPosition: {
    findMany: vi.fn().mockResolvedValue(mockPositions),
    findFirst: vi.fn(),
  },
  order: {
    groupBy: vi.fn().mockResolvedValue(mockOrderGroupBy),
  },
  trade: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  indexedTrade: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  $disconnect: vi.fn(),
};

vi.mock("../../services/prisma", () => ({
  getPrismaClient: () => mockPrisma,
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

  it("should return 400 for invalid address on canonical endpoint", async () => {
    const app = await createTestServer();
    const response = await app.inject({
      method: "GET",
      url: "/wallets/0xInvalidAddress/positions",
    });
    expect(response.statusCode).toBe(400);
  });

  it("should return 200 and calculate correct payout structure on canonical endpoint", async () => {
    const app = await createTestServer();
    const validAddress =
      "GINJ46CDSMNOSKETX3K5DU44435TGRWIQEM7ZVI3ON3BTOOFVJJHTWXO";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${validAddress}/positions`,
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.wallet).toBe(validAddress);
    expect(body.data.exposures[0]).toMatchObject({
      marketId: "market-1",
      marketQuestion: "Will it rain?",
      yesShares: 50,
      noShares: 10,
      netExposure: 40,
    });
  });

  it("should return wallet exposure rows with standardized success response", async () => {
    const app = await createTestServer();
    const wallet = "GINJ46CDSMNOSKETX3K5DU44435TGRWIQEM7ZVI3ON3BTOOFVJJHTWXO";
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

  it("should omit PnL fields by default (includePnl not set)", async () => {
    const app = await createTestServer();
    const wallet = "GINJ46CDSMNOSKETX3K5DU44435TGRWIQEM7ZVI3ON3BTOOFVJJHTWXO";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions`,
    });
    const { data } = JSON.parse(response.body);

    expect(data.pnlRealized).toBeUndefined();
    expect(data.pnlUnrealized).toBeUndefined();
    expect(data.pnlTotal).toBeUndefined();
    for (const exposure of data.exposures) {
      expect(exposure.pnlRealized).toBeUndefined();
      expect(exposure.pnlUnrealized).toBeUndefined();
    }
  });

  it("should include pnlRealized on settled positions when includePnl=true", async () => {
    const app = await createTestServer();
    const wallet = "GINJ46CDSMNOSKETX3K5DU44435TGRWIQEM7ZVI3ON3BTOOFVJJHTWXO";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions?includePnl=true`,
    });
    const { data } = JSON.parse(response.body);

    // market-2: YES won, 100 yes shares, cost=60 → pnl = 100 - 60 = 40.00000000
    const settled = data.exposures.find((e: any) => e.marketId === "market-2");
    expect(settled.pnlRealized).toBe("40.00000000");
    expect(settled.pnlUnrealized).toBeNull();
  });

  it("should include pnlUnrealized on open positions using mid-price when includePnl=true", async () => {
    const app = await createTestServer();
    const wallet = "GINJ46CDSMNOSKETX3K5DU44435TGRWIQEM7ZVI3ON3BTOOFVJJHTWXO";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions?includePnl=true`,
    });
    const { data } = JSON.parse(response.body);

    // market-1: mid=0.55, yes=50, no=10, cost=25.5
    // markValue = 50*0.55 + 10*0.45 = 27.5 + 4.5 = 32.0
    // pnlUnrealized = 32.0 - 25.5 = 6.5 → "6.50000000"
    const open = data.exposures.find((e: any) => e.marketId === "market-1");
    expect(open.pnlUnrealized).toBe("6.50000000");
    expect(open.pnlRealized).toBeNull();
  });

  it("should return correct pnlTotal, pnlRealized, pnlUnrealized summary when includePnl=true", async () => {
    const app = await createTestServer();
    const wallet = "GINJ46CDSMNOSKETX3K5DU44435TGRWIQEM7ZVI3ON3BTOOFVJJHTWXO";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions?includePnl=true`,
    });
    const { data } = JSON.parse(response.body);

    // realized=40, unrealized=6.5, total=46.5
    expect(data.pnlRealized).toBe("40.00000000");
    expect(data.pnlUnrealized).toBe("6.50000000");
    expect(data.pnlTotal).toBe("46.50000000");
  });

  it("should return 200 with empty list and zero totals for new wallet (empty state, includePnl=true)", async () => {
    const { getPrismaClient } = await import("../../services/prisma");
    const prisma = getPrismaClient() as any;
    prisma.userPosition.findMany.mockResolvedValueOnce([]);
    prisma.order.groupBy.mockResolvedValueOnce([]);

    const app = await createTestServer();
    const wallet = "GINJ46CDSMNOSKETX3K5DU44435TGRWIQEM7ZVI3ON3BTOOFVJJHTWXO";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions?includePnl=true`,
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

  it("should return null pnlUnrealized when no open orders exist to price position (includePnl=true)", async () => {
    const { getPrismaClient } = await import("../../services/prisma");
    const prisma = getPrismaClient() as any;
    prisma.userPosition.findMany.mockResolvedValueOnce([mockPositions[0]]);
    prisma.order.groupBy.mockResolvedValueOnce([]); // no orders

    const app = await createTestServer();
    const wallet = "GINJ46CDSMNOSKETX3K5DU44435TGRWIQEM7ZVI3ON3BTOOFVJJHTWXO";
    const response = await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions?includePnl=true`,
    });

    const { data } = JSON.parse(response.body);
    expect(data.exposures[0].pnlUnrealized).toBeNull();
    expect(data.pnlUnrealized).toBe("0.00000000");
  });

  it("should not query the order book when includePnl is not set", async () => {
    const { getPrismaClient } = await import("../../services/prisma");
    const prisma = getPrismaClient() as any;
    prisma.order.groupBy.mockClear();

    const app = await createTestServer();
    const wallet = "GINJ46CDSMNOSKETX3K5DU44435TGRWIQEM7ZVI3ON3BTOOFVJJHTWXO";
    await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions`,
    });

    expect(prisma.order.groupBy).not.toHaveBeenCalled();
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
