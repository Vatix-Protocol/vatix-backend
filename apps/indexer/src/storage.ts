import { getPrismaClient } from "../../../src/services/prisma.js";
import type { Logger } from "./logger.js";

export interface CursorStorageClient {
  loadCursor(): Promise<string | null>;
  saveCursor(cursor: string): Promise<void>;
}

export class PrismaCursorStorageClient implements CursorStorageClient {
  private readonly prisma = getPrismaClient();

  constructor(
    private readonly networkId: string,
    private readonly cursorKey: string,
    private readonly logger?: Logger
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
}
