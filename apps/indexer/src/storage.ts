import { getPrismaClient } from "../../../src/services/prisma.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";

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
}
