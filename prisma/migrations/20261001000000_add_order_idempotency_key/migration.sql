-- Add a caller-supplied replay key to orders.
--
-- The column is nullable and uniquely indexed: rows written before this
-- migration, and any write that omits a key, stay NULL, and Postgres allows
-- many NULLs in a unique index, so the constraint is safe to apply to a live
-- table and never blocks ordinary order traffic.
ALTER TABLE "orders" ADD COLUMN "idempotency_key" VARCHAR(64);

-- AlterIndex
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders"("idempotency_key");
