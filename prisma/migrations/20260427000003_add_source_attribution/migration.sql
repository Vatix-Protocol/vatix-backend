-- Source attribution for oracle data providers (#124)
-- Adds OracleSource enum, ResolutionCandidateStatus enum, resolution_candidates table,
-- and oracle_source_aliases mapping table for provider alias normalisation.

-- CreateEnum
CREATE TYPE "ResolutionCandidateStatus" AS ENUM ('PROPOSED', 'CHALLENGED', 'ACCEPTED', 'REJECTED');

-- CreateEnum: standardized oracle provider identifiers
CREATE TYPE "OracleSource" AS ENUM ('CHAINLINK', 'PYTH', 'UMA', 'API3', 'INTERNAL', 'MANUAL');

-- CreateTable
CREATE TABLE "resolution_candidates" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "proposed_outcome" BOOLEAN NOT NULL,
    "source" "OracleSource" NOT NULL,
    "status" "ResolutionCandidateStatus" NOT NULL DEFAULT 'PROPOSED',
    "confidence_score" DECIMAL(5,4),
    "operator_address" VARCHAR(56) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resolution_candidates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "resolution_candidates_confidence_score_check"
        CHECK ("confidence_score" IS NULL OR ("confidence_score" >= 0.0 AND "confidence_score" <= 1.0))
);

-- CreateTable: provider alias mapping
CREATE TABLE "oracle_source_aliases" (
    "id" SERIAL NOT NULL,
    "alias" TEXT NOT NULL,
    "canonical_source" "OracleSource" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oracle_source_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resolution_candidates_market_id_idx" ON "resolution_candidates"("market_id");

-- CreateIndex
CREATE INDEX "resolution_candidates_status_idx" ON "resolution_candidates"("status");

-- CreateIndex
CREATE INDEX "resolution_candidates_source_idx" ON "resolution_candidates"("source");

-- CreateIndex
CREATE INDEX "resolution_candidates_market_id_status_idx" ON "resolution_candidates"("market_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "oracle_source_aliases_alias_key" ON "oracle_source_aliases"("alias");

-- CreateIndex
CREATE INDEX "oracle_source_aliases_canonical_source_idx" ON "oracle_source_aliases"("canonical_source");

-- AddForeignKey
ALTER TABLE "resolution_candidates" ADD CONSTRAINT "resolution_candidates_market_id_fkey"
    FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
