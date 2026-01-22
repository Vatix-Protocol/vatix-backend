-- CreateTable
CREATE TABLE "markets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "question" TEXT NOT NULL,
    "end_time" DATETIME NOT NULL,
    "resolution_time" DATETIME,
    "oracle_address" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "outcome" BOOLEAN,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "market_id" TEXT NOT NULL,
    "user_address" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "price" DECIMAL NOT NULL,
    "quantity" INTEGER NOT NULL,
    "filled_quantity" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "orders_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_positions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "market_id" TEXT NOT NULL,
    "user_address" TEXT NOT NULL,
    "yes_shares" INTEGER NOT NULL DEFAULT 0,
    "no_shares" INTEGER NOT NULL DEFAULT 0,
    "locked_collateral" DECIMAL NOT NULL DEFAULT 0,
    "is_settled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_positions_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "markets_status_idx" ON "markets"("status");

-- CreateIndex
CREATE INDEX "markets_end_time_idx" ON "markets"("end_time");

-- CreateIndex
CREATE INDEX "markets_status_end_time_idx" ON "markets"("status", "end_time");

-- CreateIndex
CREATE INDEX "orders_market_id_idx" ON "orders"("market_id");

-- CreateIndex
CREATE INDEX "orders_user_address_idx" ON "orders"("user_address");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_market_id_outcome_price_created_at_idx" ON "orders"("market_id", "outcome", "price", "created_at");

-- CreateIndex
CREATE INDEX "user_positions_market_id_idx" ON "user_positions"("market_id");

-- CreateIndex
CREATE INDEX "user_positions_user_address_idx" ON "user_positions"("user_address");

-- CreateIndex
CREATE UNIQUE INDEX "user_positions_market_id_user_address_key" ON "user_positions"("market_id", "user_address");
