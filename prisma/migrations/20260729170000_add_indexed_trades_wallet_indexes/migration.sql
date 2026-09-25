-- Add wallet-address indexes to indexed_trades so per-wallet positions queries
-- (prisma.indexedTrade.findMany({ where: { OR: [{ traderAddress }, { counterpartyAddress }] } }))
-- hit an index instead of a full table scan. Mirrors the existing per-column
-- index pattern already used on trades.buyer_address / trades.seller_address.

-- CreateIndex
CREATE INDEX "indexed_trades_trader_address_idx" ON "indexed_trades"("trader_address");

-- CreateIndex
CREATE INDEX "indexed_trades_counterparty_address_idx" ON "indexed_trades"("counterparty_address");
