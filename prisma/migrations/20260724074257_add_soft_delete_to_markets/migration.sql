-- Add soft delete support to markets table
-- Add deleted_at column to track soft deletion
ALTER TABLE "markets" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- Create index on deleted_at for efficient filtering of non-deleted markets
CREATE INDEX "markets_deleted_at_idx" ON "markets"("deleted_at");
