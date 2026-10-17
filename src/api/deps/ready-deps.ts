import type { PrismaClient } from "../../generated/prisma/client";

export interface ReadyDeps {
  /**
   * Returns the instant of the most recent successful ledger ingestion, or
   * `null` when the indexer has never ingested anything (no cursor row).
   *
   * The timestamp is derived from the cursor row's `updatedAt` column, which
   * is the only timestamp available on `IndexerCursor` (there is no dedicated
   * ingestion timestamp column). `updatedAt` is therefore a proxy: it advances
   * whenever the cursor row is written for any reason, not strictly when a
   * ledger was ingested. A cursor row touched by an unrelated update can report
   * a fresher instant than actual ingestion progress.
   */
  getLastIndexedAt: () => Promise<number | null>;
}

export interface CreateReadyDepsOptions {
  prisma?: Pick<PrismaClient, "indexerCursor">;
  getLastIndexedAt?: () => Promise<number | null>;
}

export function createReadyDeps(options: CreateReadyDepsOptions = {}): ReadyDeps {
  const prisma = options.prisma;

  const getLastIndexedAt =
    options.getLastIndexedAt ??
    (async (): Promise<number | null> => {
      if (!prisma) {
        return null;
      }

      const cursor = await prisma.indexerCursor.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true, cursorValue: true },
      });

      if (!cursor) {
        return null;
      }

      // A cursor value of 0 (genesis ledger) is a valid cursor; only a
      // missing/null/undefined value means "no cursor".
      if (cursor.cursorValue === null || cursor.cursorValue === undefined) {
        return null;
      }

      return cursor.updatedAt.getTime();
    });

  return { getLastIndexedAt };
}
