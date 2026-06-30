-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('ACTIVE', 'RESOLVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "markets" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "question"        TEXT           NOT NULL,
    "end_time"        TIMESTAMPTZ    NOT NULL,
    "resolution_time" TIMESTAMPTZ,
    "oracle_address"  VARCHAR(56)    NOT NULL,
    "status"          "MarketStatus" NOT NULL DEFAULT 'ACTIVE',
    "outcome"         BOOLEAN,
    "created_at"      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    "updated_at"      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "markets_status_idx"            ON "markets" ("status");
CREATE INDEX "markets_end_time_idx"          ON "markets" ("end_time");
CREATE INDEX "markets_status_end_time_idx"   ON "markets" ("status", "end_time");
CREATE INDEX "markets_status_created_at_idx" ON "markets" ("status", "created_at" DESC);
