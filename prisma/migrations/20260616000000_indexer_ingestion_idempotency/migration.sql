-- CreateTable
CREATE TABLE "indexer_processed_events" (
    "idempotency_key" VARCHAR(64) NOT NULL,
    "event_kind" VARCHAR(32) NOT NULL,
    "ledger" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indexer_processed_events_pkey" PRIMARY KEY ("idempotency_key")
);

-- CreateTable
CREATE TABLE "indexed_trades" (
    "id" TEXT NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "event_id" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "market_id" TEXT NOT NULL,
    "trader_address" VARCHAR(56) NOT NULL,
    "counterparty_address" VARCHAR(56) NOT NULL,
    "direction" VARCHAR(8) NOT NULL,
    "outcome" VARCHAR(8) NOT NULL,
    "price_raw" TEXT NOT NULL,
    "quantity_raw" TEXT NOT NULL,
    "buy_order_id" TEXT NOT NULL,
    "sell_order_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indexed_trades_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "resolution_candidates" ADD COLUMN "idempotency_key" VARCHAR(64);

-- CreateIndex
CREATE INDEX "indexer_processed_events_ledger_idx" ON "indexer_processed_events"("ledger");

-- CreateIndex
CREATE UNIQUE INDEX "indexed_trades_idempotency_key_key" ON "indexed_trades"("idempotency_key");

-- CreateIndex
CREATE INDEX "indexed_trades_market_id_idx" ON "indexed_trades"("market_id");

-- CreateIndex
CREATE INDEX "indexed_trades_ledger_idx" ON "indexed_trades"("ledger");

-- CreateIndex
CREATE UNIQUE INDEX "resolution_candidates_idempotency_key_key" ON "resolution_candidates"("idempotency_key");
