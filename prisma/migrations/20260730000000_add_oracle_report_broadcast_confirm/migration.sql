-- Oracle submission crash-safety (#996): durable intent -> broadcast -> confirm
-- state machine keyed by (market_id, payload_hash).

-- AlterTable
ALTER TABLE "oracle_reports"
  ADD COLUMN "broadcast_at" TIMESTAMP(3),
  ADD COLUMN "confirmed_at" TIMESTAMP(3);

-- Prior to this migration, a retried/redelivered submission could insert a
-- new oracle_reports row per attempt instead of reusing one keyed by
-- (market_id, payload_hash). Collapse any such duplicates down to the most
-- recent row per key so the new unique constraint below can be applied
-- cleanly, without losing the newest (most authoritative) status/tx_hash.
DELETE FROM "oracle_reports" a
USING "oracle_reports" b
WHERE a."market_id" IS NOT NULL
  AND a."market_id" = b."market_id"
  AND a."payload_hash" = b."payload_hash"
  AND (
    a."created_at" < b."created_at"
    OR (a."created_at" = b."created_at" AND a."id" < b."id")
  );

-- CreateIndex
CREATE UNIQUE INDEX "oracle_reports_market_id_payload_hash_key" ON "oracle_reports"("market_id", "payload_hash");
