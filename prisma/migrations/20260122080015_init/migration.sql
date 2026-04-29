-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('ACTIVE', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'FILLED', 'CANCELLED', 'PARTIALLY_FILLED');

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('YES', 'NO');

-- CreateTable
CREATE TABLE "markets" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "end_time" TIMESTAMP(3) NOT NULL,
    "resolution_time" TIMESTAMP(3),
    "oracle_address" VARCHAR(56) NOT NULL,
    "status" "MarketStatus" NOT NULL DEFAULT 'ACTIVE',
    "outcome" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "user_address" VARCHAR(56) NOT NULL,
    "side" "OrderSide" NOT NULL,
    "outcome" "Outcome" NOT NULL,
    "price" DECIMAL(10,8) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "filled_quantity" INTEGER NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_positions" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "user_address" VARCHAR(56) NOT NULL,
    "yes_shares" INTEGER NOT NULL DEFAULT 0,
    "no_shares" INTEGER NOT NULL DEFAULT 0,
    "locked_collateral" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "is_settled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_positions_pkey" PRIMARY KEY ("id")
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

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_positions" ADD CONSTRAINT "user_positions_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
