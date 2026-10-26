import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { db } from '../db';
import { requireAdmin } from '../middleware/auth';
import { logger } from '../logger';

const router = Router();

/**
 * Stable error codes for the admin market surface.
 * Clients must branch on these codes, never on human-readable messages.
 */
export const MarketErrorCode = {
  UNAUTHORIZED: 'MARKET_UNAUTHORIZED',
  FORBIDDEN: 'MARKET_FORBIDDEN',
  NOT_FOUND: 'MARKET_NOT_FOUND',
  NOT_SOFT_DELETED: 'MARKET_NOT_SOFT_DELETED',
  INVALID_INPUT: 'MARKET_INVALID_INPUT',
  CONFLICT: 'MARKET_CONFLICT',
  DEPENDENCY_UNAVAILABLE: 'MARKET_DEPENDENCY_UNAVAILABLE',
} as const;

export type MarketErrorCode =
  (typeof MarketErrorCode)[keyof typeof MarketErrorCode];

interface MarketErrorBody {
  error: {
    code: MarketErrorCode;
    message: string;
    correlationId: string;
  };
}

function fail(
  res: Response,
  status: number,
  code: MarketErrorCode,
  message: string,
  correlationId: string,
): Response<MarketErrorBody> {
  return res.status(status).json({
    error: { code, message, correlationId },
  });
}

const restoreParamsSchema = z.object({
  id: z.string().min(1),
});

/**
 * Maximum page size accepted by GET /markets.
 */
const MARKETS_MAX_LIMIT = 100;

/**
 * GET /markets
 *
 * Query params:
 *  - `status`: optional market status filter.
 *  - `cursor`: optional opaque cursor (market id). An empty string is treated
 *    as absent so we never forward `id: { gt: "" }` to Prisma.
 *  - `limit`: optional page size. Must be a positive integer within
 *    MARKETS_MAX_LIMIT; anything else (NaN, negatives, zero, too large) is
 *    rejected with 400 rather than silently coerced.
 */
router.get('/markets', async (req: Request, res: Response) => {
  const correlationId = randomUUID();

  const rawStatus = req.query.status;
  const rawCursor = req.query.cursor;
  const rawLimit = req.query.limit;

  if (rawStatus !== undefined && typeof rawStatus !== 'string') {
    return fail(
      res,
      400,
      MarketErrorCode.INVALID_INPUT,
      'Invalid status',
      correlationId,
    );
  }

  if (rawCursor !== undefined && typeof rawCursor !== 'string') {
    return fail(
      res,
      400,
      MarketErrorCode.INVALID_INPUT,
      'Invalid cursor',
      correlationId,
    );
  }

  // Empty cursor is treated as absent (documented above).
  const cursor =
    typeof rawCursor === 'string' && rawCursor.length > 0
      ? rawCursor
      : undefined;

  let limit: number | undefined;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string') {
      return fail(
        res,
        400,
        MarketErrorCode.INVALID_INPUT,
        'Invalid limit',
        correlationId,
      );
    }
    // Explicit integer check: reject NaN, non-integers, negatives, zero, and
    // values above the documented maximum.
    const parsedLimit = Number(rawLimit);
    if (
      !Number.isInteger(parsedLimit) ||
      parsedLimit <= 0 ||
      parsedLimit > MARKETS_MAX_LIMIT
    ) {
      return fail(
        res,
        400,
        MarketErrorCode.INVALID_INPUT,
        'Invalid limit',
        correlationId,
      );
    }
    limit = parsedLimit;
  }

  const where: Record<string, unknown> = {};
  if (rawStatus !== undefined) {
    where.status = rawStatus;
  }
  if (cursor !== undefined) {
    where.id = { gt: cursor };
  }

  try {
    const markets = await db.market.findMany({
      where,
      take: limit,
      orderBy: { id: 'asc' },
    });
    return res.status(200).json({ data: markets, correlationId });
  } catch (err) {
    logger.error('market.list.failed', {
      correlationId,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return fail(
      res,
      503,
      MarketErrorCode.DEPENDENCY_UNAVAILABLE,
      'Markets temporarily unavailable',
      correlationId,
    );
  }
});

/**
 * POST /admin/markets/:id/restore
 *
 * Restores a previously soft-deleted market. Invariants (see
 * docs/SOFT_DELETED_MARKETS.md):
 *  - Only markets currently in the soft-deleted state may be restored.
 *  - Hard-deleted or unknown markets are never resurrected.
 *  - The operation is idempotent: a replayed/concurrent restore of an
 *    already-restored market returns the current state without re-applying.
 *  - Deny-by-default: requires an authenticated admin role.
 */
router.post(
  '/admin/markets/:id/restore',
  requireAdmin,
  async (req: Request, res: Response) => {
    const correlationId = randomUUID();

    const parsed = restoreParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return fail(
        res,
        400,
        MarketErrorCode.INVALID_INPUT,
        'Invalid market id',
        correlationId,
      );
    }
    const { id } = parsed.data;

    try {
      // Atomic conditional update: only a row that is currently soft-deleted
      // is transitioned back to active. This makes concurrent/replayed
      // restores safe — the second writer matches zero rows.
      const restored = await db.market.updateMany({
        where: { id, deletedAt: { not: null }, hardDeletedAt: null },
        data: { deletedAt: null, restoredAt: new Date() },
      });

      if (restored.count === 1) {
        logger.info('market.restore.applied', {
          correlationId,
          marketId: id,
          actorId: req.user?.id,
        });
        return res.status(200).json({
          data: { id, status: 'active', restored: true },
          correlationId,
        });
      }

      // No row transitioned: either already active (idempotent replay) or the
      // market does not exist / was hard-deleted.
      const market = await db.market.findUnique({ where: { id } });

      if (!market || market.hardDeletedAt) {
        return fail(
          res,
          404,
          MarketErrorCode.NOT_FOUND,
          'Market not found',
          correlationId,
        );
      }

      if (market.deletedAt === null) {
        // Already restored — idempotent success, no state change.
        logger.info('market.restore.idempotent', {
          correlationId,
          marketId: id,
          actorId: req.user?.id,
        });
        return res.status(200).json({
          data: { id, status: 'active', restored: false },
          correlationId,
        });
      }

      return fail(
        res,
        409,
        MarketErrorCode.CONFLICT,
        'Market could not be restored',
        correlationId,
      );
    } catch (err) {
      // Fail-closed on dependency outage: never report success on a write we
      // could not confirm.
      logger.error('market.restore.failed', {
        correlationId,
        marketId: id,
        actorId: req.user?.id,
        error: err instanceof Error ? err.message : 'unknown',
      });
      return fail(
        res,
        503,
        MarketErrorCode.DEPENDENCY_UNAVAILABLE,
        'Restore temporarily unavailable',
        correlationId,
      );
    }
  },
);

export default router;
