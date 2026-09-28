-- Idempotency ledger for POST /v1/orders: one row per (signer, Idempotency-Key),
-- written in the same transaction as the order it created.
-- CreateTable
CREATE TABLE "order_idempotency_keys" (
    "user_address" VARCHAR(56) NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "order_id" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_idempotency_keys_pkey" PRIMARY KEY ("user_address","idempotency_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_idempotency_keys_order_id_key" ON "order_idempotency_keys"("order_id");

-- CreateIndex
CREATE INDEX "order_idempotency_keys_created_at_idx" ON "order_idempotency_keys"("created_at");

-- AddForeignKey
ALTER TABLE "order_idempotency_keys" ADD CONSTRAINT "order_idempotency_keys_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
