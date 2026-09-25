-- Create table for durable indexer cursor checkpoints
-- Composite primary key keeps state isolated per network + cursor stream.
CREATE TABLE "indexer_cursors" (
    "network_id" TEXT NOT NULL,
    "cursor_key" TEXT NOT NULL,
    "cursor_value" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indexer_cursors_pkey" PRIMARY KEY ("network_id", "cursor_key")
);

CREATE INDEX "indexer_cursors_network_id_idx" ON "indexer_cursors"("network_id");
