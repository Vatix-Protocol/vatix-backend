-- CreateTable
CREATE TABLE "oracle_reports" (
    "id" TEXT NOT NULL,
    "source" VARCHAR(256) NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "market_id" TEXT,
    "candidate_resolution" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oracle_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "oracle_reports_market_id_idx" ON "oracle_reports"("market_id");

-- CreateIndex
CREATE INDEX "oracle_reports_source_idx" ON "oracle_reports"("source");

-- CreateIndex
CREATE INDEX "oracle_reports_created_at_idx" ON "oracle_reports"("created_at");

-- AddForeignKey
ALTER TABLE "oracle_reports" ADD CONSTRAINT "oracle_reports_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
