import { getPrismaClient } from "../../../src/services/prisma.js";
import type { Logger } from "./logger.js";

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
  /**
   * Persist `cursor` and run `writeBatch` inside a single database
   * transaction. If `writeBatch` throws (or the DB rejects the write), the
   * cursor upsert is rolled back as well — the cursor can never advance
   * without the corresponding batch being durably committed.
   *
   * `expectedPreviousCursor`, when provided, is compared against the
   * currently stored cursor inside the same transaction; a mismatch means
   * another writer already advanced the cursor (e.g. a stale matching
   * leader) and raises `CursorConflictError` instead of silently
   * overwriting it.
   */
  saveCursorWithBatch(
    cursor: string,
    writeBatch: (tx: CursorTransactionClient) => Promise<void>,
    expectedPreviousCursor?: string | null
  ): Promise<void>;
}

export class PrismaCursorStorageClient implements CursorStorageClient {
  private readonly prisma = getPrismaClient();

  constructor(
    private readonly networkId: string,
    private readonly cursorKey: string,
    private readonly logger?: Logger
  ) {
    if (
      process.env.NODE_ENV === "production" &&
      (!networkId || !cursorKey)
    ) {
      throw new CursorStorageConfigError(
        "PrismaCursorStorageClient requires networkId and cursorKey in production; refusing to persist a cursor under an empty/ambiguous key"
      );
    }
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
        cursor: true,
      },
    });

    const cursor = row?.cursor ?? null;
    this.logger?.debug("Ledger cursor loaded", {
      networkId: this.networkId,
      cursorKey: this.cursorKey,
      cursor,
      found: cursor !== null,
    });
    return cursor;
  }

  async saveCursor(cursor: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
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
    this.logger?.debug("Ledger cursor saved", {
      networkId: this.networkId,
      cursorKey: this.cursorKey,
      cursor,
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
