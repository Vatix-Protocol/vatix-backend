/**
 * Backfill trades table from Redis audit stream.
 *
 * Run once after deploying the trades migration to seed historical records
 * that predate the durable Postgres writes. Safe to re-run: upserts are
 * idempotent on tradeId.
 *
 * Usage:  npx tsx scripts/backfill-trades.ts
 */
import { redis } from "../src/services/redis.js";
import { getPrismaClient } from "../src/services/prisma.js";

const GLOBAL_STREAM = "audit:trades:global";
const BATCH = 500;

async function main() {
  const prisma = getPrismaClient();
  let cursor = "-";
  let total = 0;

  console.log("Starting trades backfill from Redis audit stream…");

  while (true) {
    const entries: [string, string[]][] = await redis.xrange(
      GLOBAL_STREAM,
      cursor,
      "+",
      "COUNT",
      BATCH
    );

    if (entries.length === 0) break;

    for (const [, fields] of entries) {
      const data: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        data[fields[i]] = fields[i + 1];
      }

      await prisma.trade.upsert({
        where: { tradeId: data.tradeId },
        create: {
          tradeId: data.tradeId,
          marketId: data.marketId,
          outcome: data.outcome,
          buyerAddress: data.buyerAddress,
          sellerAddress: data.sellerAddress,
          buyOrderId: data.buyOrderId,
          sellOrderId: data.sellOrderId,
          price: data.price,
          quantity: parseInt(data.quantity, 10),
          tradedAt: new Date(parseInt(data.timestamp, 10)),
        },
        update: {},
      });
      total++;
    }

    const lastId = entries[entries.length - 1][0];
    // Advance cursor past the last seen ID
    const [ms, seq] = lastId.split("-");
    cursor = `${ms}-${Number(seq) + 1}`;

    if (entries.length < BATCH) break;
  }

  console.log(`Backfill complete. Upserted ${total} trade(s).`);
  await redis.disconnect();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
