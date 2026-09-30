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

  it("plans an index scan on the per-wallet composite index for a wallet history query", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const buyer = "G" + "B".repeat(55);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      tradeId: `idx-wallet-verify-${i}`,
      marketId: market.id,
      outcome: "YES",
      buyerAddress: buyer,
      sellerAddress: "G" + "S".repeat(55),
      buyOrderId: `idx-wallet-buy-${i}`,
      sellOrderId: `idx-wallet-sell-${i}`,
      price: 0.5,
      quantity: 1,
      tradedAt: new Date(Date.now() - i * 1000),
    }));
    await prisma.trade.createMany({ data: rows });

    // Mirrors AuditService.getWalletTradeHistory: filter on the address,
    // order by traded_at DESC. The (buyer_address, traded_at DESC) index
    // serves both the filter and the ordering.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
      return tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `EXPLAIN (FORMAT JSON) SELECT * FROM trades WHERE buyer_address = '${buyer}' ORDER BY traded_at DESC LIMIT 20`
      );
    });

    const planJson = JSON.stringify(plan);
    expect(planJson).toContain("trades_buyer_address_traded_at_idx");
  });

  // ---------------------------------------------------------------------
  // #1144 composite indexes
  //
  // The composite indexes only earn their write cost if the planner actually
  // reaches for them. These assertions mirror the query shapes documented in
  // docs/schema.md; a regression that drops one of the indexes, or reorders
  // its columns, turns the scan back into a sort and would otherwise be
  // invisible until production history grew deep enough to hurt.
  // ---------------------------------------------------------------------

  it("plans an index scan on trades_market_id_traded_at_idx for market-scoped history", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const rows = Array.from({ length: 20 }, (_, i) => ({
      tradeId: `idx-market-verify-${i}`,
      marketId: market.id,
      outcome: "YES",
      buyerAddress: "G" + "B".repeat(55),
      sellerAddress: "G" + "S".repeat(55),
      buyOrderId: `idx-market-buy-${i}`,
      sellOrderId: `idx-market-sell-${i}`,
      price: 0.5,
      quantity: 1,
      tradedAt: new Date(Date.now() - i * 1000),
    }));
    await prisma.trade.createMany({ data: rows });

    // The shape documented in docs/schema.md: filter on market_id, order by
    // traded_at DESC. Only the composite index returns rows already ordered;
    // the single-column trades_market_id_idx would still require a sort.
    // `market_id` is `text` (not a uuid FK) on this table, so it is compared
    // as text.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
      return tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `EXPLAIN (FORMAT JSON) SELECT * FROM trades WHERE market_id = '${market.id}' ORDER BY traded_at DESC LIMIT 20`
      );
    });

    const planJson = JSON.stringify(plan);
    expect(planJson).toContain("trades_market_id_traded_at_idx");
    // The whole point of the composite is that the sort disappears with it.
    // Asserting only the index name would not catch a regression: Postgres
    // happily falls back to the single-column trades_market_id_idx, which
    // finds the same rows but returns them unordered and forces a sort of the
    // market's entire history before the LIMIT applies.
    expect(planJson).not.toContain('"Sort Key"');
    expect(planJson).not.toContain("trades_market_id_idx");
  });

  it("plans an index scan on trades_settlement_status_traded_at_idx for the settlement sweep", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const rows = Array.from({ length: 20 }, (_, i) => ({
      tradeId: `idx-settlement-verify-${i}`,
      marketId: market.id,
      outcome: "YES",
      buyerAddress: "G" + "B".repeat(55),
      sellerAddress: "G" + "S".repeat(55),
      buyOrderId: `idx-settle-buy-${i}`,
      sellOrderId: `idx-settle-sell-${i}`,
      price: 0.5,
      quantity: 1,
      tradedAt: new Date(Date.now() - i * 1000),
    }));
    await prisma.trade.createMany({ data: rows });

    // The settlement worker drains unsettled trades oldest-first, so the
    // composite must be (settlement_status, traded_at ASC) to serve the scan
    // in order.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
      return tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `EXPLAIN (FORMAT JSON) SELECT * FROM trades WHERE settlement_status = 'PENDING'::"SettlementStatus" ORDER BY traded_at ASC LIMIT 20`
      );
    });

    const planJson = JSON.stringify(plan);
    expect(planJson).toContain("trades_settlement_status_traded_at_idx");
  });
});
