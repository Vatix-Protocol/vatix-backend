-- Add QUARANTINED status to OutboxStatus enum
ALTER TYPE "OutboxStatus" ADD VALUE 'QUARANTINED';

-- Add quarantined_at timestamp column to track when an entry was quarantined
ALTER TABLE "outbox_events"
ADD COLUMN "quarantined_at" TIMESTAMP(3);

-- Create index for finding quarantined entries efficiently
CREATE INDEX "outbox_events_quarantined_at_idx" ON "outbox_events"("quarantined_at");
