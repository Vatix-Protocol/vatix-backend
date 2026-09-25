import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestPrismaClient, testUtils } from "../setup.js";
import {
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../helpers/test-database.js";

/**
 * Verifies the assumption behind the recent-trades query (AuditService.getTradeHistory,
 * `ORDER BY traded_at DESC` with no filter): that it can be served by the
 * `@@index([tradedAt(sort: Desc)])` index on Trade (Postgres name: trades_traded_at_idx)
 * rather than a full table scan. `enable_seqscan` is forced off so the assertion
 * reflects index availability/usability rather than the planner's cost heuristic
 * on a small fixture table.
 */
describe("recent-trades query uses the traded_at index", () => {
  const prisma = getTestPrismaClient();

  beforeAll(async () => {
    await acquireDatabaseLock();
  });

  afterAll(async () => {
    await releaseDatabaseLock();
  });

  it("plans an index scan on trades_traded_at_idx for unfiltered ORDER BY traded_at DESC", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const rows = Array.from({ length: 20 }, (_, i) => ({
      tradeId: `idx-verify-${i}`,
      marketId: market.id,
      outcome: "YES",
      buyerAddress: "G" + "B".repeat(55),
      sellerAddress: "G" + "S".repeat(55),
      buyOrderId: `idx-buy-${i}`,
      sellOrderId: `idx-sell-${i}`,
      price: 0.5,
      quantity: 1,
      tradedAt: new Date(Date.now() - i * 1000),
    }));
    await prisma.trade.createMany({ data: rows });

    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
      return tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `EXPLAIN (FORMAT JSON) SELECT * FROM trades ORDER BY traded_at DESC LIMIT 20`
      );
    });

    const planJson = JSON.stringify(plan);
    expect(planJson).toContain("trades_traded_at_idx");
  });
});
