-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "trade_id" VARCHAR(256) NOT NULL,
    "market_id" TEXT NOT NULL,
    "outcome" VARCHAR(8) NOT NULL,
    "buyer_address" VARCHAR(56) NOT NULL,
    "seller_address" VARCHAR(56) NOT NULL,
    "buy_order_id" TEXT NOT NULL,
    "sell_order_id" TEXT NOT NULL,
    "price" DECIMAL(10,8) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "traded_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trades_trade_id_key" ON "trades"("trade_id");

-- CreateIndex
CREATE INDEX "trades_market_id_idx" ON "trades"("market_id");

-- CreateIndex
CREATE INDEX "trades_buyer_address_idx" ON "trades"("buyer_address");

-- CreateIndex
CREATE INDEX "trades_seller_address_idx" ON "trades"("seller_address");

-- CreateIndex
CREATE INDEX "trades_buyer_address_traded_at_idx" ON "trades"("buyer_address", "traded_at" DESC);

-- CreateIndex
CREATE INDEX "trades_seller_address_traded_at_idx" ON "trades"("seller_address", "traded_at" DESC);
