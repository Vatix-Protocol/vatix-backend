-- Add composite index on status + created_at to support efficient market listing filters
-- This index covers the common query pattern: filter by status, order by created_at DESC

-- CreateIndex
CREATE INDEX "markets_status_created_at_idx" ON "markets"("status", "created_at" DESC);
