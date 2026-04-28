-- Create resolutions table for finalized market resolutions
-- Keyed by market ID with enforcement of one active final resolution per market
-- Includes outcome, finalized_at, and provenance (source attribution) fields
-- correction_override_metadata captures history of corrections and overrides

-- CreateEnum for resolution status states
CREATE TYPE "ResolutionStatus" AS ENUM ('ACTIVE', 'CORRECTED', 'OVERRIDDEN');

-- CreateTable: market resolutions
CREATE TABLE "resolutions" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "outcome" BOOLEAN NOT NULL,
    "finalized_at" TIMESTAMP(3) NOT NULL,
    "provenance" TEXT NOT NULL,
    "status" "ResolutionStatus" NOT NULL DEFAULT 'ACTIVE',
    "correction_override_metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resolutions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "resolutions_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE CASCADE
);

-- Enforce one active final resolution per market
-- Partial unique index on market_id where status = 'ACTIVE'
CREATE UNIQUE INDEX "resolutions_market_id_active_idx" ON "resolutions"("market_id") WHERE "status" = 'ACTIVE';

-- CreateIndex for efficient lookups by market
CREATE INDEX "resolutions_market_id_idx" ON "resolutions"("market_id");

-- CreateIndex for querying by status
CREATE INDEX "resolutions_status_idx" ON "resolutions"("status");

-- CreateIndex for temporal queries
CREATE INDEX "resolutions_finalized_at_idx" ON "resolutions"("finalized_at");

-- CreateIndex for compound lookups
CREATE INDEX "resolutions_market_id_status_idx" ON "resolutions"("market_id", "status");

-- CreateIndex for efficient ordering/pagination
CREATE INDEX "resolutions_created_at_idx" ON "resolutions"("created_at" DESC);
