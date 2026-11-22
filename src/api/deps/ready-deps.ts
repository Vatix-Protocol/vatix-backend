import type { PrismaClient } from "../../generated/prisma/client";
import {
  checkDbReadiness,
  DEFAULT_READINESS_TIMEOUT_MS,
  makeError,
  type DbReadinessError,
} from "../../services/dbReadiness.js";
import { redis } from "../../services/redis.js";

export interface ReadyDeps {
  /**
   * Throws if the database is unreachable.
   */
  checkDatabase(): Promise<void>;
  /**
   * Throws if the Redis instance is unreachable or the check exceeds its
   * deadline. Redis is a CRITICAL dependency: a failure here makes `/ready`
   * return 503.
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
      // Bounded deadline: a hung Redis must fail readiness (503) rather than
      // leave the probe hanging until the orchestrator's own timeout.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(makeError("DEPENDENCY_TIMEOUT"));
        }, DEFAULT_READINESS_TIMEOUT_MS);
      });

      try {
        const ok = await Promise.race([redis.healthCheck(), timeout]);
        if (!ok) {
          throw makeError("DEPENDENCY_UNAVAILABLE");
        }
      } catch (error) {
        if (
          error instanceof Error &&
          (error as DbReadinessError).code === "DEPENDENCY_TIMEOUT"
        ) {
          throw error;
        }
        throw makeError("DEPENDENCY_UNAVAILABLE", error);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
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
