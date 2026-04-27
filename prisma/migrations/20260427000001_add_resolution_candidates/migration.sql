-- CreateEnum
CREATE TYPE "ResolutionCandidateStatus" AS ENUM ('PROPOSED', 'CHALLENGED', 'ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "resolution_candidates" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "proposed_outcome" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "status" "ResolutionCandidateStatus" NOT NULL DEFAULT 'PROPOSED',
    "operator_address" VARCHAR(56) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resolution_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resolution_candidates_market_id_idx" ON "resolution_candidates"("market_id");

-- CreateIndex
CREATE INDEX "resolution_candidates_status_idx" ON "resolution_candidates"("status");

-- CreateIndex
CREATE INDEX "resolution_candidates_market_id_status_idx" ON "resolution_candidates"("market_id", "status");

-- AddForeignKey
ALTER TABLE "resolution_candidates" ADD CONSTRAINT "resolution_candidates_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
