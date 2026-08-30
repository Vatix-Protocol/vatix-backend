-- AlterTable: trades.outcome Outcome enum -> VARCHAR(8) to match schema
ALTER TABLE "trades" ALTER COLUMN "outcome" DROP DEFAULT;
ALTER TABLE "trades" ALTER COLUMN "outcome" TYPE VARCHAR(8) USING ("outcome"::text);

-- AlterTable: outbox_events.updated_at default
ALTER TABLE "outbox_events" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "trade_audit_events" (
    "id" TEXT NOT NULL,
    "trade_id" VARCHAR(256) NOT NULL,
    "market_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "prev_hash" VARCHAR(64) NOT NULL,
    "entry_hash" VARCHAR(64) NOT NULL,
    "stream_id" TEXT NOT NULL,
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_stream_watermarks" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "global_stream_id" TEXT NOT NULL,
    "market_stream_id" TEXT NOT NULL,
    "last_archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archive_initiated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trade_stream_watermarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_actions" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "actor" VARCHAR(256) NOT NULL,
    "before_status" VARCHAR(16) NOT NULL,
    "after_status" VARCHAR(16) NOT NULL,
    "orders_cancelled" INTEGER NOT NULL DEFAULT 0,
    "collateral_released" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "request_id" VARCHAR(256) NOT NULL,
    "approval_token" VARCHAR(256),
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_approval_tokens" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "initiator" VARCHAR(256) NOT NULL,
    "request_id" VARCHAR(256) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "approved_by" VARCHAR(256),
    "approved_at" TIMESTAMP(3),
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_approval_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_reconciliation_jobs" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "wallet" VARCHAR(56) NOT NULL,
    "drift_detected" BOOLEAN NOT NULL,
    "divergence" JSONB NOT NULL,
    "recovery_applied" BOOLEAN NOT NULL DEFAULT false,
    "recovery_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "position_reconciliation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_reconciliations" (
    "id" TEXT NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "deposit_id" TEXT NOT NULL,
    "wallet" VARCHAR(56) NOT NULL,
    "market_id" TEXT NOT NULL,
    "amount_raw" TEXT NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "reconciliation_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_audit_events_stream_id_key" ON "trade_audit_events"("stream_id");
CREATE INDEX "trade_audit_events_market_id_idx" ON "trade_audit_events"("market_id");
CREATE INDEX "trade_audit_events_trade_id_idx" ON "trade_audit_events"("trade_id");
CREATE INDEX "trade_audit_events_archived_at_idx" ON "trade_audit_events"("archived_at");

CREATE UNIQUE INDEX "trade_stream_watermarks_market_id_key" ON "trade_stream_watermarks"("market_id");

CREATE INDEX "admin_actions_market_id_idx" ON "admin_actions"("market_id");
CREATE INDEX "admin_actions_action_idx" ON "admin_actions"("action");
CREATE INDEX "admin_actions_created_at_idx" ON "admin_actions"("created_at" DESC);

CREATE UNIQUE INDEX "admin_approval_tokens_request_id_key" ON "admin_approval_tokens"("request_id");
CREATE INDEX "admin_approval_tokens_market_id_idx" ON "admin_approval_tokens"("market_id");
CREATE INDEX "admin_approval_tokens_action_idx" ON "admin_approval_tokens"("action");
CREATE INDEX "admin_approval_tokens_expires_at_idx" ON "admin_approval_tokens"("expires_at");

CREATE INDEX "position_reconciliation_jobs_market_id_idx" ON "position_reconciliation_jobs"("market_id");
CREATE INDEX "position_reconciliation_jobs_wallet_idx" ON "position_reconciliation_jobs"("wallet");
CREATE INDEX "position_reconciliation_jobs_drift_detected_idx" ON "position_reconciliation_jobs"("drift_detected");

CREATE UNIQUE INDEX "deposit_reconciliations_idempotency_key_key" ON "deposit_reconciliations"("idempotency_key");
CREATE INDEX "deposit_reconciliations_market_id_idx" ON "deposit_reconciliations"("market_id");
CREATE INDEX "deposit_reconciliations_wallet_idx" ON "deposit_reconciliations"("wallet");
CREATE INDEX "deposit_reconciliations_status_idx" ON "deposit_reconciliations"("status");
