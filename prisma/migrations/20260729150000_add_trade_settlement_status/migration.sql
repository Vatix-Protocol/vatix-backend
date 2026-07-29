-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'SETTLED', 'QUARANTINED');

-- AlterTable
ALTER TABLE "trades"
  ADD COLUMN "settlement_status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "settled_at" TIMESTAMP(3),
  ADD COLUMN "settlement_tx_hash" VARCHAR(64),
  ADD COLUMN "settlement_error_code" VARCHAR(64),
  ADD COLUMN "settlement_failure_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "quarantined_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "trades_settlement_status_idx" ON "trades"("settlement_status");
