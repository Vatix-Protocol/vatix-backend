-- DropForeignKey
ALTER TABLE "positions" DROP CONSTRAINT "positions_market_id_fkey";

-- DropTable
DROP TABLE "positions";
