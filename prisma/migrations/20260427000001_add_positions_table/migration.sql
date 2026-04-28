-- Migration: Add positions table for wallet market positions snapshot/projection
-- 
-- This table stores the current state of each wallet's position in a market.
-- It supports upsert from indexer updates for fast position queries.
--
-- Strategy: Snapshot-based (see packages/db/migrations/README.md for details)

-- CreateEnum (if not already exists - safe to run multiple times)
DO $$ BEGIN
    CREATE TYPE "Outcome" AS ENUM ('YES', 'NO');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable: positions
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "wallet_address" VARCHAR(56) NOT NULL,
    "market_id" TEXT NOT NULL,
    "outcome" "Outcome",
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "valuation" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Fast lookup by wallet address
CREATE INDEX "positions_wallet_address_idx" ON "positions"("wallet_address");

-- CreateIndex: Fast lookup by market
CREATE INDEX "positions_market_id_idx" ON "positions"("market_id");

-- CreateIndex: Unique constraint for upsert operations
-- Keyed by wallet + market (+ outcome if needed)
CREATE UNIQUE INDEX "positions_wallet_market_outcome_key" ON "positions"("wallet_address", "market_id", "outcome");

-- AddForeignKey: Link to markets table
ALTER TABLE "positions" ADD CONSTRAINT "positions_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
