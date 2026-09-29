import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

/**
 * Executed form of RESOLUTION_MIGRATION_TESTING.md (#1118).
 *
 * The doc lists acceptance criteria as SQL to be run by hand. This file runs
 * them against a real migrated Postgres so the criteria are enforced in CI
 * rather than trusted: a hand-edited migration that drops the partial unique
 * index, loosens the FK, or loses the correction metadata column fails here.
 *
 * Invariants tested are the ones the doc claims, verbatim:
 *   A. A resolution is keyed by market id and retrievable by it.
 *   B. outcome / finalized_at / provenance / status round-trip.
 *   C. At most one ACTIVE resolution per market (partial unique index).
 *   D. CORRECTED / OVERRIDDEN history is retained and still retrievable.
 *   E. Deleting a market cascades to its resolutions.
 *   F. Every index and the enum the doc lists actually exist.
 */

let pool: Pool;
let prisma: PrismaClient;

const createdMarketIds: string[] = [];
let marketSeq = 0;

function nextMarketId(): string {
  marketSeq += 1;
  const id = `res-migration-test-market-${Date.now()}-${marketSeq}`;
  createdMarketIds.push(id);
  return id;
}

async function createMarket(id: string) {
  return prisma.market.create({
    data: {
      id,
      question: `Will the migration test market ${id} resolve?`,
      endTime: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      oracleAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    },
  });
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  prisma = new PrismaClient({ adapter });
});

afterEach(async () => {
  // Resolutions go with the market (ON DELETE CASCADE), but clear explicitly
  // so a broken cascade shows up as a failure in test E rather than silently
  // leaking rows into the next test.
  await prisma.resolution.deleteMany({
    where: { marketId: { in: createdMarketIds } },
  });
  await prisma.market.deleteMany({ where: { id: { in: createdMarketIds } } });
  createdMarketIds.length = 0;
  marketSeq = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
  await pool.end();
});

describe("resolutions migration — acceptance criteria (RESOLUTION_MIGRATION_TESTING.md)", () => {
  it("A. keys a resolution by market id and retrieves it by that key", async () => {
    const marketId = nextMarketId();
    await createMarket(marketId);

    await prisma.resolution.create({
      data: {
        marketId,
        outcome: true,
        finalizedAt: new Date(),
        provenance: "CHAINLINK",
        status: "ACTIVE",
      },
    });

    const byMarketId = await prisma.resolution.findMany({
      where: { marketId },
    });
    expect(byMarketId).toHaveLength(1);
    expect(byMarketId[0].marketId).toBe(marketId);
  });

  it("B. round-trips outcome, finalizedAt, provenance and status", async () => {
    const marketId = nextMarketId();
    await createMarket(marketId);

    const finalizedAt = new Date("2026-04-28T12:00:00.000Z");
    await prisma.resolution.create({
      data: { marketId, outcome: false, finalizedAt, provenance: "PYTH" },
    });

    const found = await prisma.resolution.findFirstOrThrow({
      where: { marketId },
    });
    expect(found.outcome).toBe(false);
    expect(found.finalizedAt.toISOString()).toBe(finalizedAt.toISOString());
    expect(found.provenance).toBe("PYTH");
    // DEFAULT 'ACTIVE' comes from the migration, not from Prisma, so a raw
    // SQL insert gets it too.
    expect(found.status).toBe("ACTIVE");
  });

  // The core invariant of the table. Enforced by the partial unique index, so
  // this asserts the database rejects the second row — not merely that
  // application code would avoid writing one.
  it("C. permits at most one ACTIVE resolution per market", async () => {
    const marketId = nextMarketId();
    await createMarket(marketId);

    await prisma.resolution.create({
      data: {
        marketId,
        outcome: true,
        finalizedAt: new Date(),
        provenance: "UMA",
      },
    });

    await expect(
      prisma.resolution.create({
        data: {
          marketId,
          outcome: false,
          finalizedAt: new Date(),
          provenance: "UMA",
        },
      })
    ).rejects.toThrow();

    expect(await prisma.resolution.count({ where: { marketId } })).toBe(1);

    // The doc's verification query must return no violations.
    const { rows } = await pool.query<{
      market_id: string;
      active_count: string;
    }>(
      `SELECT market_id, COUNT(*) AS active_count
         FROM resolutions
        WHERE status = 'ACTIVE'
        GROUP BY market_id
       HAVING COUNT(*) > 1`
    );
    expect(rows).toEqual([]);
  });

  // Partial index: only ACTIVE rows are constrained, so history survives a
  // correction instead of being overwritten or deleted.
  it("D. keeps CORRECTED/OVERRIDDEN history alongside the new ACTIVE row", async () => {
    const marketId = nextMarketId();
    await createMarket(marketId);

    const original = await prisma.resolution.create({
      data: {
        marketId,
        outcome: false,
        finalizedAt: new Date(),
        provenance: "CHAINLINK",
      },
    });

    await prisma.resolution.update({
      where: { id: original.id },
      data: {
        status: "CORRECTED",
        correctionOverrideMetadata: {
          corrected_at: new Date().toISOString(),
          previous_outcome: false,
          reason: "Oracle data validation issue",
        },
      },
    });

    const replacement = await prisma.resolution.create({
      data: {
        marketId,
        outcome: true,
        finalizedAt: new Date(),
        provenance: "MANUAL",
      },
    });

    const all = await prisma.resolution.findMany({
      where: { marketId },
      orderBy: { createdAt: "asc" },
    });
    expect(all).toHaveLength(2);

    const corrected = all.find((r) => r.id === original.id)!;
    expect(corrected.status).toBe("CORRECTED");
    expect(corrected.correctionOverrideMetadata).toMatchObject({
      previous_outcome: false,
      reason: "Oracle data validation issue",
    });
    expect(replacement.status).toBe("ACTIVE");

    // The uniqueness holds only among ACTIVE rows — proven by the two
    // coexisting rows above and by clearing ACTIVE here.
    await prisma.resolution.update({
      where: { id: replacement.id },
      data: { status: "OVERRIDDEN" },
    });
    expect(
      await prisma.resolution.count({ where: { marketId, status: "ACTIVE" } })
    ).toBe(0);
  });

  it("E. cascades resolution deletes when the market is deleted", async () => {
    const marketId = nextMarketId();
    await createMarket(marketId);

    await prisma.resolution.create({
      data: {
        marketId,
        outcome: true,
        finalizedAt: new Date(),
        provenance: "API3",
      },
    });

    await prisma.market.delete({ where: { id: marketId } });

    // The FK is ON DELETE CASCADE; an orphaned resolution would mean the
    // migration lost it.
    expect(await prisma.resolution.count({ where: { marketId } })).toBe(0);
  });

  it("rejects a resolution for a market that does not exist (FK enforced)", async () => {
    await expect(
      prisma.resolution.create({
        data: {
          marketId: "market-that-does-not-exist",
          outcome: true,
          finalizedAt: new Date(),
          provenance: "CHAINLINK",
        },
      })
    ).rejects.toThrow();
  });

  it("F. creates every index the doc lists", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'resolutions'`
    );
    const present = new Set(rows.map((r) => r.indexname));

    for (const index of [
      "resolutions_pkey",
      "resolutions_market_id_active_idx",
      "resolutions_market_id_idx",
      "resolutions_status_idx",
      "resolutions_finalized_at_idx",
      "resolutions_market_id_status_idx",
      "resolutions_created_at_idx",
    ]) {
      expect(present).toContain(index);
    }
  });

  it("creates the ResolutionStatus enum with exactly the documented values", async () => {
    // The type name is case-sensitive: unquoted `ResolutionStatus::regtype`
    // folds to `resolutionstatus` and matches nothing.
    const { rows } = await pool.query<{ enumlabel: string }>(
      `SELECT e.enumlabel
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ResolutionStatus'
        ORDER BY e.enumsortorder`
    );
    expect(rows.map((r) => r.enumlabel)).toEqual([
      "ACTIVE",
      "CORRECTED",
      "OVERRIDDEN",
    ]);
  });
});
