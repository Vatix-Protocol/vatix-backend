-- CreateTable
CREATE TABLE "collateral_deposits" (
    "id" TEXT NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "event_id" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "contract_id" TEXT NOT NULL,
    "account" VARCHAR(56) NOT NULL,
    "market_id" TEXT NOT NULL,
    "amount_raw" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collateral_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "collateral_deposits_idempotency_key_key" ON "collateral_deposits"("idempotency_key");

-- CreateIndex
CREATE INDEX "collateral_deposits_account_idx" ON "collateral_deposits"("account");

-- CreateIndex
CREATE INDEX "collateral_deposits_market_id_idx" ON "collateral_deposits"("market_id");

-- CreateIndex
CREATE INDEX "collateral_deposits_account_market_id_idx" ON "collateral_deposits"("account", "market_id");

-- CreateIndex
CREATE INDEX "collateral_deposits_ledger_idx" ON "collateral_deposits"("ledger");
