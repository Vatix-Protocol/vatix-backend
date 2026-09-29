-- Trade-history composite indexes (#1144).
--
-- The read paths served by `trades` are:
--
--   getWalletTradeHistory   WHERE (buyer_address = $1 OR seller_address = $1)
--                                  [AND market_id = $2]
--                                  [AND traded_at BETWEEN $3 AND $4]
--                           ORDER BY traded_at DESC
--   getMarketTradeHistory   WHERE market_id = $1 [AND traded_at BETWEEN ..]
--                           ORDER BY traded_at DESC
--
-- (buyer_address, traded_at DESC) and (seller_address, traded_at DESC) already
-- exist and cover the per-wallet case, but the market-scoped history had no
-- index whose leading column matched its filter, so Postgres fell back to a
-- bitmap scan plus an explicit sort. These two composites remove that sort
-- and make both history queries index range scans.
--
-- (settlement_status, traded_at DESC) serves settlement reconciliation, which
-- scans unsettled trades oldest-first; the single-column settlement_status
-- index cannot return rows already in traded_at order.
--
-- Created CONCURRENTLY so this is non-blocking on a live table. It cannot run
-- inside a transaction block, which is why this migration uses a single
-- statement per index and is excluded from the transactional deploy path.
-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "trades_market_id_traded_at_idx" ON "trades"("market_id", "traded_at" DESC);

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "trades_settlement_status_traded_at_idx" ON "trades"("settlement_status", "traded_at" DESC);
