import { describe, it, expect, beforeEach } from "vitest";
import { ExpiryJob } from "./job.js";
import { getPrismaClient } from "../../../../src/services/prisma.js";
import { createLogger } from "../../../indexer/src/logger.js";

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("ExpiryJob Integration Tests", () => {
  let prisma: ReturnType<typeof getPrismaClient>;
  let job: ExpiryJob;

  beforeEach(async () => {
    prisma = getPrismaClient();
    job = new ExpiryJob(prisma, mockLogger as any, {});
  });

  it("should expire markets and cancel remaining orders", async () => {
    const pastEndTime = new Date(Date.now() - 60 * 1000);
    const futureEndTime = new Date(Date.now() + 60 * 1000);

    const market = await prisma.market.create({
      data: {
        question: "Should expire?",
        endTime: pastEndTime,
        resolutionTime: null,
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALQ",
        status: "ACTIVE",
      },
    });

    const activeMarket = await prisma.market.create({
      data: {
        question: "Should not expire?",
        endTime: futureEndTime,
        resolutionTime: null,
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALQ",
        status: "ACTIVE",
      },
    });

    const userAddress =
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

    await prisma.userPosition.create({
      data: {
        marketId: market.id,
        userAddress,
        yesShares: 0,
        noShares: 0,
        lockedCollateral: 500,
      },
    });

    const order = await prisma.order.create({
      data: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 1000,
        filledQuantity: 0,
        status: "OPEN",
      },
    });

    const result = await job.run();

    expect(result.totalCandidates).toBeGreaterThanOrEqual(1);
    expect(result.expiredCount).toBeGreaterThanOrEqual(1);

    const expiredMarketResult = result.candidates.find(
      (c) => c.marketId === market.id
    );
    expect(expiredMarketResult).toBeDefined();
    expect(expiredMarketResult?.status).toBe("expired");
    expect(expiredMarketResult?.ordersCount).toBe(1);
    expect(expiredMarketResult?.collateralReleased).toBeGreaterThan(0);

    const updatedMarket = await prisma.market.findUnique({
      where: { id: market.id },
    });
    expect(updatedMarket?.status).toBe("CANCELLED");

    const updatedOrder = await prisma.order.findUnique({
      where: { id: order.id },
    });
    expect(updatedOrder?.status).toBe("CANCELLED");

    const updatedPosition = await prisma.userPosition.findUnique({
      where: {
        marketId_userAddress: {
          marketId: market.id,
          userAddress,
        },
      },
    });
    expect(updatedPosition?.lockedCollateral).toBeLessThan(500);

    const notExpiredMarket = await prisma.market.findUnique({
      where: { id: activeMarket.id },
    });
    expect(notExpiredMarket?.status).toBe("ACTIVE");

    await prisma.market.deleteMany({
      where: { id: { in: [market.id, activeMarket.id] } },
    });
  });

  it("should handle markets with multiple resting orders", async () => {
    const pastEndTime = new Date(Date.now() - 60 * 1000);

    const market = await prisma.market.create({
      data: {
        question: "Multi-order expiry?",
        endTime: pastEndTime,
        resolutionTime: null,
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALQ",
        status: "ACTIVE",
      },
    });

    const users = [
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF",
    ];

    for (const userAddress of users) {
      await prisma.userPosition.create({
        data: {
          marketId: market.id,
          userAddress,
          yesShares: 0,
          noShares: 0,
          lockedCollateral: 1000,
        },
      });

      await prisma.order.create({
        data: {
          marketId: market.id,
          userAddress,
          side: "BUY",
          outcome: "YES",
          price: 0.5,
          quantity: 1000,
          filledQuantity: 0,
          status: "OPEN",
        },
      });

      await prisma.order.create({
        data: {
          marketId: market.id,
          userAddress,
          side: "SELL",
          outcome: "NO",
          price: 0.3,
          quantity: 500,
          filledQuantity: 0,
          status: "PARTIALLY_FILLED",
        },
      });
    }

    const result = await job.run();

    const marketResult = result.candidates.find(
      (c) => c.marketId === market.id
    );
    expect(marketResult?.ordersCount).toBe(4);
    expect(marketResult?.status).toBe("expired");

    const cancelledOrders = await prisma.order.findMany({
      where: {
        marketId: market.id,
        status: "CANCELLED",
      },
    });
    expect(cancelledOrders).toHaveLength(4);

    await prisma.market.delete({ where: { id: market.id } });
  });

  it("should be idempotent on re-run", async () => {
    const pastEndTime = new Date(Date.now() - 60 * 1000);

    const market = await prisma.market.create({
      data: {
        question: "Idempotent expiry?",
        endTime: pastEndTime,
        resolutionTime: null,
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALQ",
        status: "ACTIVE",
      },
    });

    const userAddress =
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

    await prisma.userPosition.create({
      data: {
        marketId: market.id,
        userAddress,
        yesShares: 0,
        noShares: 0,
        lockedCollateral: 500,
      },
    });

    await prisma.order.create({
      data: {
        marketId: market.id,
        userAddress,
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 1000,
        filledQuantity: 0,
        status: "OPEN",
      },
    });

    const firstRun = await job.run();
    expect(firstRun.expiredCount).toBeGreaterThanOrEqual(1);

    const secondRun = await job.run();
    expect(secondRun.expiredCount).toBe(0);

    await prisma.market.delete({ where: { id: market.id } });
  });
});
