import type { PrismaClient } from "../../generated/prisma/client";
import { checkDbReadiness } from "../../services/dbReadiness.js";
import { redis } from "../../services/redis.js";

export interface ReadyDeps {
  /**
   * Throws if the database is unreachable.
   */
  checkDatabase(): Promise<void>;
  /**
   * Throws if the Redis instance is unreachable.
   * NOTE: Redis failures set redis.status = "error" in the response but do
   * NOT change the HTTP status code — Redis is a WARNING-tier dependency.
   */
  checkRedis(): Promise<void>;
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
  /**
   * Probes database readiness. Defaults to the production `checkDbReadiness`
   * (which resolves the Prisma singleton) but can be overridden so tests can
   * inject a fake client without a live Postgres.
   */
  checkDbReadiness: (options?: {
    client?: Pick<PrismaClient, "$queryRaw">;
    timeoutMs?: number;
  }) => Promise<void>;
}

export interface CreateReadyDepsOptions {
  prisma?: Pick<PrismaClient, "indexerCursor" | "$queryRaw">;
  checkDatabase?: () => Promise<void>;
  checkRedis?: () => Promise<void>;
  getLastIndexedAt?: () => Promise<number | null>;
  checkDbReadiness?: (options?: {
    client?: Pick<PrismaClient, "$queryRaw">;
    timeoutMs?: number;
  }) => Promise<void>;
}

export function createReadyDeps(options: CreateReadyDepsOptions = {}): ReadyDeps {
  const prisma = options.prisma;

  const checkDatabase =
    options.checkDatabase ??
    (async (): Promise<void> => {
      await checkDbReadiness();
    });

  const checkRedisImpl =
    options.checkRedis ??
    (async (): Promise<void> => {
      const ok = await redis.healthCheck();
      if (!ok) {
        throw new Error("Redis health check failed");
      }
    });

  const getLastIndexedAt =
    options.getLastIndexedAt ??
    (async (): Promise<number | null> => {
      if (!prisma) {
        return null;
      }

      const cursor = await (prisma as Pick<PrismaClient, "indexerCursor">).indexerCursor.findFirst({
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

  const checkDbReadinessFn = options.checkDbReadiness ?? checkDbReadiness;

  return {
    checkDatabase,
    checkRedis: checkRedisImpl,
    getLastIndexedAt,
    checkDbReadiness: checkDbReadinessFn,
  };
}
