-- Add confidence_score to resolution_candidates
-- Scoring scale: 0.0 (no confidence) to 1.0 (full confidence), stored as DECIMAL(5,4)
-- Nullable: null indicates the source did not report a confidence value
-- Application-level constraint: value must be between 0.0 and 1.0 inclusive

-- AlterTable
ALTER TABLE "resolution_candidates" ADD COLUMN "confidence_score" DECIMAL(5,4);

-- AddCheckConstraint
ALTER TABLE "resolution_candidates" ADD CONSTRAINT "resolution_candidates_confidence_score_check"
    CHECK ("confidence_score" IS NULL OR ("confidence_score" >= 0.0 AND "confidence_score" <= 1.0));
