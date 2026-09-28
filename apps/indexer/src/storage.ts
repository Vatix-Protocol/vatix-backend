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
    const current = await this.prisma.indexerCursor.findUnique({
      where: {
        networkId_cursorKey: {
          networkId: this.networkId,
          cursorKey: this.cursorKey,
        },
      },
      select: { cursorValue: true },
    });
    const currentCursor = current?.cursorValue ?? null;
    if (currentCursor !== null && cursor < currentCursor) {
      throw new CursorConflictError(currentCursor, cursor);
    }
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
          select: { cursorValue: true },
        });
        const currentCursor = current?.cursorValue ?? null;
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

/**
 * Stable error codes for the admin soft-delete restore path. These are part of
 * the public contract: clients and runbooks key off these strings, so they must
 * not change without a coordinated migration.
 */
export const RESTORE_MARKET_ERROR_CODES = {
  UNAUTHORIZED: "RESTORE_MARKET_UNAUTHORIZED",
  FORBIDDEN: "RESTORE_MARKET_FORBIDDEN",
  NOT_FOUND: "RESTORE_MARKET_NOT_FOUND",
  NOT_SOFT_DELETED: "RESTORE_MARKET_NOT_SOFT_DELETED",
  CONFLICT: "RESTORE_MARKET_CONFLICT",
  STORAGE_UNAVAILABLE: "RESTORE_MARKET_STORAGE_UNAVAILABLE",
} as const;

export type RestoreMarketErrorCode =
  (typeof RESTORE_MARKET_ERROR_CODES)[keyof typeof RESTORE_MARKET_ERROR_CODES];

/** Typed error for the admin restore path. Carries a stable code + correlation id. */
export class RestoreMarketError extends Error {
  constructor(
    readonly code: RestoreMarketErrorCode,
    message: string,
    readonly correlationId: string
  ) {
    super(message);
    this.name = "RestoreMarketError";
  }
}

/** Roles permitted to invoke the admin restore path. Deny-by-default. */
export const RESTORE_MARKET_ALLOWED_ROLES = ["admin", "ops"] as const;
export type RestoreMarketRole = (typeof RESTORE_MARKET_ALLOWED_ROLES)[number];

/**
 * Authenticated principal for the restore path. `expiresAt` is epoch millis.
 * Anything missing/unknown is treated as unauthorized (fail-closed).
 */
export interface RestoreMarketActor {
  actorId: string;
  role: string;
  expiresAt: number;
}

export interface RestoreMarketRequest {
  marketId: string;
  actor: RestoreMarketActor | null | undefined;
  /** Optional client-supplied idempotency key; defaults to marketId. */
  idempotencyKey?: string;
  /** Injectable clock for deterministic tests. */
  now?: number;
}

export interface RestoreMarketResult {
  marketId: string;
  restored: boolean;
  /** True when the request was a no-op replay of an already-restored market. */
  idempotentReplay: boolean;
  restoredAt: Date | null;
  correlationId: string;
}

/**
 * Minimal Prisma surface the restore path depends on. Kept narrow so the
 * admin path can be unit-tested without a live database.
 */
export interface RestoreMarketStore {
  findMarketById(
    marketId: string
  ): Promise<{ id: string; deletedAt: Date | null } | null>;
  /**
   * Atomically clears `deletedAt` only when it is currently non-null.
   * Returns the number of rows affected (0 when already live / not found).
   */
  restoreSoftDeletedMarket(marketId: string, restoredAt: Date): Promise<number>;
}

/**
 * Admin soft-delete restore entrypoint.
 *
 * Invariants (see docs/SOFT_DELETED_MARKETS.md):
 *  - Only previously soft-deleted markets may be restored. Hard-deleted or
 *    unknown markets are never resurrected.
 *  - Deny-by-default authz: missing/expired/wrong-role actors fail closed.
 *  - Idempotent: concurrent or replayed restores never double-apply; a replay
 *    of an already-restored market returns `idempotentReplay: true`.
 *  - Fail-closed on storage outage: errors surface as STORAGE_UNAVAILABLE and
 *    never report success.
 */
export async function restoreSoftDeletedMarket(
  store: RestoreMarketStore,
  request: RestoreMarketRequest,
  logger?: ILogger
): Promise<RestoreMarketResult> {
  const correlationId =
    request.idempotencyKey ?? `restore:${request.marketId}`;
  const now = request.now ?? Date.now();

  const fail = (code: RestoreMarketErrorCode, message: string): never => {
    logger?.warn("Admin market restore rejected", {
      event: "admin.market.restore.rejected",
      code,
      marketId: request.marketId,
      correlationId,
    });
    throw new RestoreMarketError(code, message, correlationId);
  };

  // Deny-by-default authz. Unknown actor, expired auth, or wrong role all fail
  // closed before any storage access.
  const actor = request.actor;
  if (!actor || !actor.actorId) {
    fail(RESTORE_MARKET_ERROR_CODES.UNAUTHORIZED, "Authentication required");
  }
  if (typeof actor.expiresAt !== "number" || actor.expiresAt <= now) {
    fail(RESTORE_MARKET_ERROR_CODES.UNAUTHORIZED, "Authentication expired");
  }
  if (!(RESTORE_MARKET_ALLOWED_ROLES as readonly string[]).includes(actor.role)) {
    fail(RESTORE_MARKET_ERROR_CODES.FORBIDDEN, "Insufficient role for restore");
  }

  let existing: { id: string; deletedAt: Date | null } | null;
  try {
    existing = await store.findMarketById(request.marketId);
  } catch (err) {
    logger?.error("Admin market restore storage failure", {
      event: "admin.market.restore.storage_error",
      marketId: request.marketId,
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
    fail(
      RESTORE_MARKET_ERROR_CODES.STORAGE_UNAVAILABLE,
      "Market storage unavailable"
    );
  }

  // Unknown market: never resurrect. Hard-deleted rows are indistinguishable
  // from unknown here, so both fail closed with NOT_FOUND.
  if (!existing) {
    fail(RESTORE_MARKET_ERROR_CODES.NOT_FOUND, "Market not found");
  }

  // Already live: idempotent replay, no write performed.
  if (existing.deletedAt === null) {
    logger?.info("Admin market restore idempotent replay", {
      event: "admin.market.restore.replay",
      marketId: request.marketId,
      correlationId,
    });
    return {
      marketId: request.marketId,
      restored: false,
      idempotentReplay: true,
      restoredAt: null,
      correlationId,
    };
  }

  const restoredAt = new Date(now);
  let affected: number;
  try {
    // Conditional update (deletedAt IS NOT NULL) makes concurrent restores
    // safe: only one writer observes a non-zero row count.
    affected = await store.restoreSoftDeletedMarket(request.marketId, restoredAt);
  } catch (err) {
    logger?.error("Admin market restore storage failure", {
      event: "admin.market.restore.storage_error",
      marketId: request.marketId,
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
    fail(
      RESTORE_MARKET_ERROR_CODES.STORAGE_UNAVAILABLE,
      "Market storage unavailable"
    );
  }

  if (affected === 0) {
    // Lost the race: another writer restored it first. Treat as idempotent.
    logger?.info("Admin market restore lost race, treating as replay", {
      event: "admin.market.restore.replay",
      marketId: request.marketId,
      correlationId,
    });
    return {
      marketId: request.marketId,
      restored: false,
      idempotentReplay: true,
      restoredAt: null,
      correlationId,
    };
  }

  logger?.info("Admin market restored", {
    event: "admin.market.restore.succeeded",
    marketId: request.marketId,
    actorId: actor.actorId,
    correlationId,
  });

  return {
    marketId: request.marketId,
    restored: true,
    idempotentReplay: false,
    restoredAt,
    correlationId,
  };
}
