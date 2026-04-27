import { describe, it, expect, vi } from "vitest";
import fastify from "fastify";
import positionsRouter from "./positions";
import { errorHandler } from "../middleware/errorHandler";

vi.mock("../../services/prisma", () => ({
  getPrismaClient: () => ({
    userPosition: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "test-pos-1",
          userAddress:
            "GBAHUIO7S6NXF2654321098765432109876543210987654321098765",
          marketId: "market-1",
          yesShares: 50,
          noShares: 10,
          lockedCollateral: { toString: () => "25.50000000" },
          isSettled: false,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          market: {
            id: "market-1",
            question: "Will it rain?",
          },
        },
      ]),
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

describe("Positions Route", () => {
  const createTestServer = async () => {
    const app = fastify();
    app.setErrorHandler(errorHandler);
    await app.register(positionsRouter);
    return app;
  };

  it("should return 400 for invalid address", async () => {
    const app = await createTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/positions/user/0xInvalidAddress",
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("Invalid Stellar address");
  });

  it("should return 200 and calculate correct payout structure", async () => {
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
    expect(body[0].netPosition).toBe(40); // 50 - 10
    expect(body[0].market.question).toBe("Will it rain?");
  });

  it("should return wallet exposure rows with standardized success response", async () => {
    const app = await createTestServer();
    const wallet =
      "GBAHUIO7S6NXF2654321098765432109876543210987654321098765";

    const response = await app.inject({
      method: "GET",
      url: `/wallets/${wallet}/positions`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.wallet).toBe(wallet);
    expect(body.data.count).toBe(1);
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
