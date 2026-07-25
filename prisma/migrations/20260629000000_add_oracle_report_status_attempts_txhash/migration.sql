-- CreateEnum
CREATE TYPE "OracleReportStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- AlterTable
ALTER TABLE "oracle_reports"
  ADD COLUMN "status" "OracleReportStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "tx_hash" VARCHAR(64);

-- CreateIndex
CREATE INDEX "oracle_reports_status_idx" ON "oracle_reports"("status");
