import { describe, it, expect, vi, afterAll } from "vitest";
import { server } from "../../index";

vi.mock("../../services/prisma", () => ({
  getPrismaClient: () => ({
    userPosition: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "test-pos-1",
          userAddress:
            "GBAHUIO7S6NXF2654321098765432109876543210987654321098765",
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

describe("Positions Route", () => {
  it("should return 400 for invalid address", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/positions/user/0xInvalidAddress",
    });

    expect(response.statusCode).toBe(400);
  });

  it("should return 200 and calculate payout for valid address", async () => {
    const validAddress =
      "GBAHUIO7S6NXF2654321098765432109876543210987654321098765";

    const response = await server.inject({
      method: "GET",
      url: `/positions/user/${validAddress}`,
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].potentialPayout).toBe(50); // Should be max(50, 10)
    expect(body[0].market.question).toBe("Will it rain?");
  });
});
