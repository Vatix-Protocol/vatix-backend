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
