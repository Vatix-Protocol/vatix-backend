-- Source attribution for oracle data providers (#124)
-- Adds OracleSource enum and oracle_source_aliases mapping table
-- for provider alias normalisation.

-- CreateEnum: standardized oracle provider identifiers
CREATE TYPE "OracleSource" AS ENUM ('CHAINLINK', 'PYTH', 'UMA', 'API3', 'INTERNAL', 'MANUAL');

-- CreateTable: provider alias mapping
CREATE TABLE "oracle_source_aliases" (
    "id" SERIAL NOT NULL,
    "alias" TEXT NOT NULL,
    "canonical_source" "OracleSource" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oracle_source_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resolution_candidates_source_idx" ON "resolution_candidates"("source");

-- CreateIndex
CREATE UNIQUE INDEX "oracle_source_aliases_alias_key" ON "oracle_source_aliases"("alias");

-- CreateIndex
CREATE INDEX "oracle_source_aliases_canonical_source_idx" ON "oracle_source_aliases"("canonical_source");
