import { getPrismaClient } from "../../../src/services/prisma.js";

export interface CursorStorageClient {
  loadCursor(): Promise<string | null>;
  saveCursor(cursor: string): Promise<void>;
}

export class PrismaCursorStorageClient implements CursorStorageClient {
  private readonly prisma = getPrismaClient();

  constructor(
    private readonly networkId: string,
    private readonly cursorKey: string
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

    return row?.cursor ?? null;
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
  }
}
