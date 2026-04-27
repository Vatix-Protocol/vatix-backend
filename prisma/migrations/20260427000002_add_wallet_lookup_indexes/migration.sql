-- Add composite indexes for wallet + market lookups to support low-latency portfolio queries

-- CreateIndex: orders by wallet address + market (covers wallet-scoped trade history per market)
CREATE INDEX "orders_user_address_market_id_idx" ON "orders"("user_address", "market_id");

-- CreateIndex: positions by wallet address + market (covers wallet-scoped position lookups per market)
CREATE INDEX "user_positions_user_address_market_id_idx" ON "user_positions"("user_address", "market_id");
