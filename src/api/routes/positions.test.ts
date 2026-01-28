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
          userAddress: "GBAHUIO7S6NXF2654321098765432109876543210987654321098765",
          yesShares: 50,
          noShares: 10,
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
    /^G[A-Z0-9]{55}$/.test(addr) ? null : "Invalid Stellar address",
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
    const validAddress = "GBAHUIO7S6NXF2654321098765432109876543210987654321098765";

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
});