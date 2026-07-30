-- CreateTable
CREATE TABLE "resolution_audit_logs" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "before_status" VARCHAR(16) NOT NULL,
    "after_status" VARCHAR(16) NOT NULL,
    "actor" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resolution_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resolution_audit_logs_candidate_id_idx" ON "resolution_audit_logs"("candidate_id");

-- CreateIndex
CREATE INDEX "resolution_audit_logs_market_id_idx" ON "resolution_audit_logs"("market_id");

-- CreateIndex
CREATE INDEX "resolution_audit_logs_created_at_idx" ON "resolution_audit_logs"("created_at" DESC);
