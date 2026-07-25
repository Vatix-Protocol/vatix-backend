import { getPrismaClient } from "../../../src/services/prisma.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";

export interface CursorStorageClient {
  loadCursor(): Promise<string | null>;
  saveCursor(cursor: string): Promise<void>;
}

export class PrismaCursorStorageClient implements CursorStorageClient {
  private readonly prisma = getPrismaClient();

  constructor(
    private readonly networkId: string,
    private readonly cursorKey: string,
    private readonly logger?: ILogger
  ) {}

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
}
