import { getPrismaClient } from "../../../src/services/prisma.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";

/** Thrown when the production storage path is misconfigured. Fail fast, no silent fallback. */
export class CursorStorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorStorageConfigError";
  }
}

/** Raised when a batch write commits but a concurrent writer already advanced the cursor. */
export class CursorConflictError extends Error {
  constructor(expected: string | null, actual: string | null) {
    super(
      `IndexerCursor conflict: expected previous cursor ${expected ?? "null"} but found ${actual ?? "null"}`
    );
    this.name = "CursorConflictError";
  }
}

/**
 * Minimal transaction-scoped Prisma client. Callers use this to perform their
 * event/trade/resolution writes in the *same* transaction as the cursor
 * upsert, so a batch write failure rolls back the cursor advance too.
 */
export type CursorTransactionClient = Parameters<
  Parameters<ReturnType<typeof getPrismaClient>["$transaction"]>[0]
>[0];

export interface CursorStorageClient {
  loadCursor(): Promise<string | null>;
  saveCursor(cursor: string): Promise<void>;
  /** Load the last known ledger hash for reorg detection. */
  loadLedgerHash(): Promise<string | null>;
  /** Persist the ledger hash associated with the current cursor. */
  saveLedgerHash(hash: string): Promise<void>;
}

const CURSOR_KEY_HASH_SUFFIX = ":ledger_hash";

export class PrismaCursorStorageClient implements CursorStorageClient {
  private readonly prisma = getPrismaClient();
  private readonly hashCursorKey: string;

  constructor(
    private readonly networkId: string,
    private readonly cursorKey: string,
    private readonly logger?: ILogger
  ) {
    this.hashCursorKey = `${cursorKey}${CURSOR_KEY_HASH_SUFFIX}`;
  }

  async loadCursor(): Promise<string | null> {
    const row = await this.prisma.indexerCursor.findUnique({
      where: {
        networkId_cursorKey: {
          networkId: this.networkId,
          cursorKey: this.cursorKey,
        },
      },
      select: {
        cursorValue: true,
      },
    });

    const cursor = row?.cursorValue ?? null;
    this.logger?.debug("Ledger cursor loaded", {
      networkId: this.networkId,
      cursorKey: this.cursorKey,
      cursor,
      found: cursor !== null,
    });
    return cursor;
  }

  async saveCursor(cursor: string): Promise<void> {
    await this.prisma.indexerCursor.upsert({
      where: {
        networkId_cursorKey: {
          networkId: this.networkId,
          cursorKey: this.cursorKey,
        },
      },
      create: {
        networkId: this.networkId,
        cursorKey: this.cursorKey,
        cursorValue: cursor,
      },
      update: {
        cursorValue: cursor,
      },
    });
    this.logger?.info("Indexer cursor saved", {
      event: "indexer.cursor.saved",
      cursorValue: cursor,
      networkId: this.networkId,
      cursorKey: this.cursorKey,
    });
  }

  async loadLedgerHash(): Promise<string | null> {
    const row = await this.prisma.indexerCursor.findUnique({
      where: {
        networkId_cursorKey: {
          networkId: this.networkId,
          cursorKey: this.hashCursorKey,
        },
      },
      select: {
        cursorValue: true,
      },
    });

    const hash = row?.cursorValue ?? null;
    this.logger?.debug("Ledger hash loaded", {
      networkId: this.networkId,
      cursorKey: this.hashCursorKey,
      hashFound: hash !== null,
    });
    return hash;
  }

  async saveLedgerHash(hash: string): Promise<void> {
    await this.prisma.indexerCursor.upsert({
      where: {
        networkId_cursorKey: {
          networkId: this.networkId,
          cursorKey: this.hashCursorKey,
        },
      },
      create: {
        networkId: this.networkId,
        cursorKey: this.hashCursorKey,
        cursorValue: hash,
      },
      update: {
        cursorValue: hash,
      },
    });
    this.logger?.info("Ledger hash saved", {
      event: "indexer.ledger_hash.saved",
      cursorKey: this.hashCursorKey,
      networkId: this.networkId,
    });
  }

  async saveCursorWithBatch(
    cursor: string,
    writeBatch: (tx: CursorTransactionClient) => Promise<void>,
    expectedPreviousCursor?: string | null
  ): Promise<void> {
    const correlationId = `${this.networkId}:${this.cursorKey}:${cursor}`;

    await this.prisma.$transaction(async (tx) => {
      if (expectedPreviousCursor !== undefined) {
        const current = await tx.indexerCursor.findUnique({
          where: {
            networkId_cursorKey: {
              networkId: this.networkId,
              cursorKey: this.cursorKey,
            },
          },
          select: { cursor: true },
        });
        const currentCursor = current?.cursor ?? null;
        if (currentCursor !== expectedPreviousCursor) {
          throw new CursorConflictError(expectedPreviousCursor, currentCursor);
        }
      }

      // Batch writes run first: if they fail, the cursor upsert below never
      // executes and the whole transaction rolls back. This is what
      // guarantees the cursor cannot advance past ledger data that was not
      // durably persisted (no "holes").
      await writeBatch(tx);

      await tx.indexerCursor.upsert({
        where: {
          networkId_cursorKey: {
            networkId: this.networkId,
            cursorKey: this.cursorKey,
          },
        },
        create: {
          networkId: this.networkId,
          cursorKey: this.cursorKey,
          cursor,
        },
        update: {
          cursor,
        },
      });
    });

    this.logger?.debug("Ledger cursor and batch persisted atomically", {
      networkId: this.networkId,
      cursorKey: this.cursorKey,
      cursor,
      correlationId,
    });
  }
}

/**
 * Soft-delete status for a market record.
 *
 * A market is considered soft-deleted when `deletedAt` is set to a non-null
 * timestamp. Soft-deletion is a first-class status: money-path and read
 * endpoints must exclude soft-deleted markets by default.
 */
export interface MarketSoftDeleteStatus {
  deletedAt: Date | null;
}

/**
 * Prisma `where` fragment that excludes soft-deleted markets.
 *
 * Fail-closed: only markets whose `deletedAt` is explicitly `null` are
 * surfaced. If the deletion status is unknown/unavailable (e.g. the field is
 * missing or the row cannot be resolved), the market is NOT returned.
 */
export const NOT_SOFT_DELETED = { deletedAt: null } as const;

/**
 * Returns true only when the market is explicitly known to be live.
 *
 * Fail-closed: any unknown/undefined status is treated as deleted so that
 * money-path/read endpoints never surface a market whose deletion status
 * cannot be confirmed.
 */
export function isMarketVisible(
  status: MarketSoftDeleteStatus | null | undefined
): boolean {
  if (!status) {
    return false;
  }
  return status.deletedAt === null;
}

/**
 * Builds a Prisma `where` clause for market queries that excludes
 * soft-deleted markets unless the caller explicitly opts in.
 *
 * @param where  Base filter to merge with the soft-delete guard.
 * @param options.includeDeleted  Explicit opt-in for admin/audit paths only.
 */
export function marketVisibilityWhere<T extends Record<string, unknown>>(
  where: T = {} as T,
  options: { includeDeleted?: boolean } = {}
): T & { deletedAt?: null } {
  if (options.includeDeleted) {
    return { ...where };
  }
  return { ...where, ...NOT_SOFT_DELETED };
}
