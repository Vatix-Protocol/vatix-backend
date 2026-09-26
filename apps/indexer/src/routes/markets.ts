import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../../../src/services/prisma.js";
import type { MarketStatus } from "../../../../src/generated/prisma/client.js";
import { NOT_SOFT_DELETED } from "../storage.js";

/**
 * Indexer read API: `GET /markets`, `GET /markets/:id`, and
 * `GET /markets/:id/trades`.
 *
 * Pagination is **keyset (cursor) based**, not offset based, for two reasons:
 *
 *  1. Correctness under concurrent writes. The indexer appends new trades and
 *     markets continuously, so an `OFFSET` page can skip or repeat rows when a
 *     row lands before the current offset between two page requests. A cursor
 *     anchored on the sort key resumes exactly where the previous page ended.
 *  2. Cost. `OFFSET n` makes Postgres walk and discard `n` rows, so deep pages
 *     degrade linearly. A keyset range scan stays index-backed at any depth.
 *
 * The cursor is the id of the last row on the previous page and the sort is
 * `id` ascending, so `id > cursor` is a direct index range scan.
 *
 * The envelope is deliberately uniform across all list routes so a client can
 * write one pagination loop:
 *
 * ```json
 * { "items": [...], "count": 20, "total": 137, "nextCursor": "id-20", "correlationId": "..." }
 * ```
 *
 * The `markets` / `market` / `trades` aliases are kept on the responses so the
 * documented response shape in the indexer README stays stable; new clients
 * should read `items` and `nextCursor`.
 *
 * Failure modes are fail-closed: a database outage returns
 * `503 MARKETS_DEPENDENCY_UNAVAILABLE` (never a partial or fabricated list)
 * and a bad cursor, limit, or id returns `400 MARKETS_VALIDATION_FAILED`.
 */

// Stable error codes for the markets/trades read API surface.
const ERR = {
  NOT_FOUND: "MARKETS_NOT_FOUND",
  TRADE_MARKET_NOT_FOUND: "TRADES_MARKET_NOT_FOUND",
  VALIDATION: "MARKETS_VALIDATION_FAILED",
  UNAVAILABLE: "MARKETS_DEPENDENCY_UNAVAILABLE",
} as const;

/** Default page size when the client does not send `limit`. */
const DEFAULT_LIMIT = 20;

/**
 * Hard upper bound on `limit`. A caller-supplied page size is attacker
 * controlled, so an unbounded `take` would let one request scan the whole
 * `trades` table and exhaust the connection pool.
 */
const MAX_LIMIT = 100;

/**
 * Hard deadline on a single list/detail query.
 *
 * Without one, a slow or contended database leaves the request (and its pooled
 * connection) pinned indefinitely, which is how a handful of slow readers turn
 * into a full outage. Bounding the query makes the failure a clean, fail-closed
 * `503` instead of an accumulating backlog.
 */
const QUERY_TIMEOUT_MS = 5_000;

/** Abort signal that cancels the Prisma query after {@link QUERY_TIMEOUT_MS}. */
function queryTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(QUERY_TIMEOUT_MS);
}

/**
 * Guard for the `id` path parameter. Market and trade ids are opaque strings in
 * the database, but an unbounded value is still a griefing vector: a
 * multi-kilobyte id would be sent verbatim into the `WHERE` clause and echoed
 * back in error messages. Reject anything that is not a short, printable,
 * non-empty token.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function correlationId(request: FastifyRequest): string {
  return (
    (request.headers["x-correlation-id"] as string | undefined) ?? request.id
  );
}

interface GetMarketsQuery {
  status?: MarketStatus;
  cursor?: string;
  limit?: number;
}

interface GetIdParams {
  id: string;
}

interface GetTradesQuery {
  cursor?: string;
  limit?: number;
}

/** Shared pagination query schema for the list routes. */
const paginationQuerystring = {
  type: "object",
  properties: {
    cursor: { type: "string", nullable: true },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      nullable: true,
    },
  },
  additionalProperties: false,
} as const;

const idParamsSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

export const marketsRoutes = async function (
  app: FastifyInstance
): Promise<void> {
  /**
   * GET /markets — keyset-paginated list of non-soft-deleted markets.
   */
  app.get<{ Querystring: GetMarketsQuery }>(
    "/markets",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            ...paginationQuerystring.properties,
            status: {
              type: "string",
              enum: ["ACTIVE", "RESOLVED", "CANCELLED"],
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const cid = correlationId(request);
      const { status, cursor, limit } = request.query;

      const parsedLimit = limit ?? DEFAULT_LIMIT;

      try {
        const where: {
          status?: MarketStatus;
          deletedAt?: null;
          id?: { gt?: string };
        } = { ...NOT_SOFT_DELETED };

        if (status) {
          where.status = status;
        }

        if (cursor) {
          where.id = { gt: cursor };
        }

        const prisma = getPrismaClient();
        // `take: limit + 1` is the standard keyset over-read: if an extra row
        // comes back there is at least one more page, so `nextCursor` is set
        // without a second round trip.
        const [markets, total] = await Promise.all([
          prisma.market.findMany(
            {
              where,
              orderBy: { id: "asc" },
              take: parsedLimit + 1,
              select: {
                id: true,
                question: true,
                endTime: true,
                resolutionTime: true,
                oracleAddress: true,
                status: true,
                outcome: true,
                createdAt: true,
              },
            },
            queryTimeoutSignal()
          ),
          prisma.market.count({ where }, queryTimeoutSignal()),
        ]);

        const hasMore = markets.length > parsedLimit;
        const items = hasMore ? markets.slice(0, parsedLimit) : markets;
        const nextCursor = hasMore ? items[items.length - 1].id : null;

        return reply.code(200).send({
          markets: items,
          items,
          count: items.length,
          total,
          nextCursor,
          correlationId: cid,
        });
      } catch (err) {
        request.log.error(
          {
            correlationId: cid,
            err: err instanceof Error ? err.message : "unknown",
          },
          "markets list query failed"
        );
        return reply.code(503).send({
          code: ERR.UNAVAILABLE,
          message: "Market data temporarily unavailable",
          correlationId: cid,
        });
      }
    }
  );

  /**
   * GET /markets/:id — single market lookup. Soft-deleted markets are treated
   * as not found so a deleted market is indistinguishable from a missing one.
   */
  app.get<{ Params: GetIdParams }>(
    "/markets/:id",
    {
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      const cid = correlationId(request);
      const { id } = request.params;

      if (!isValidId(id)) {
        return reply.code(400).send({
          code: ERR.VALIDATION,
          message: "Invalid market id",
          correlationId: cid,
        });
      }

      try {
        const prisma = getPrismaClient();
        const market = await prisma.market.findUnique(
          {
            where: { id, ...NOT_SOFT_DELETED },
            select: {
              id: true,
              question: true,
              endTime: true,
              resolutionTime: true,
              oracleAddress: true,
              status: true,
              outcome: true,
              createdAt: true,
              updatedAt: true,
            },
          },
          queryTimeoutSignal()
        );

        if (!market) {
          return reply.code(404).send({
            code: ERR.NOT_FOUND,
            message: `Market not found: ${id}`,
            correlationId: cid,
          });
        }

        return reply.code(200).send({
          market,
          correlationId: cid,
        });
      } catch (err) {
        request.log.error(
          {
            correlationId: cid,
            err: err instanceof Error ? err.message : "unknown",
          },
          "market lookup failed"
        );
        return reply.code(503).send({
          code: ERR.UNAVAILABLE,
          message: "Market data temporarily unavailable",
          correlationId: cid,
        });
      }
    }
  );

  /**
   * GET /markets/:id/trades — keyset-paginated trade history for one market.
   *
   * Sourced from `indexed_trades` (the on-chain event log the indexer writes),
   * not from the `trades` matching table: the contract remains the source of
   * truth for what actually executed, while the matching table is a local
   * projection that can lag or be re-derived. Reads are served from the index,
   * so this endpoint never blocks the money path.
   *
   * The market is resolved first (fail-closed on unknown and soft-deleted
   * markets) so a caller cannot probe trade volume for a market that is not
   * publicly visible.
   */
  app.get<{ Params: GetIdParams; Querystring: GetTradesQuery }>(
    "/markets/:id/trades",
    {
      schema: {
        params: idParamsSchema,
        querystring: paginationQuerystring,
      },
    },
    async (request, reply) => {
      const cid = correlationId(request);
      const { id } = request.params;
      const { cursor, limit } = request.query;
      const parsedLimit = limit ?? DEFAULT_LIMIT;

      if (!isValidId(id)) {
        return reply.code(400).send({
          code: ERR.VALIDATION,
          message: "Invalid market id",
          correlationId: cid,
        });
      }

      try {
        const prisma = getPrismaClient();

        // Fail-closed: an unknown or soft-deleted market yields 404 rather
        // than an empty (and indistinguishable) trade list.
        const market = await prisma.market.findUnique(
          {
            where: { id, ...NOT_SOFT_DELETED },
            select: { id: true },
          },
          queryTimeoutSignal()
        );

        if (!market) {
          return reply.code(404).send({
            code: ERR.TRADE_MARKET_NOT_FOUND,
            message: `Market not found: ${id}`,
            correlationId: cid,
          });
        }

        const where = {
          marketId: id,
          ...(cursor ? { id: { gt: cursor } } : {}),
        };

        const [trades, total] = await Promise.all([
          prisma.indexedTrade.findMany(
            {
              where,
              orderBy: { id: "asc" },
              take: parsedLimit + 1,
              select: {
                id: true,
                marketId: true,
                outcome: true,
                traderAddress: true,
                counterpartyAddress: true,
                direction: true,
                priceRaw: true,
                quantityRaw: true,
                ledger: true,
                createdAt: true,
              },
            },
            queryTimeoutSignal()
          ),
          prisma.indexedTrade.count({ where }, queryTimeoutSignal()),
        ]);

        const hasMore = trades.length > parsedLimit;
        const items = hasMore ? trades.slice(0, parsedLimit) : trades;
        const nextCursor = hasMore ? items[items.length - 1].id : null;

        return reply.code(200).send({
          trades: items,
          items,
          count: items.length,
          total,
          nextCursor,
          correlationId: cid,
        });
      } catch (err) {
        request.log.error(
          {
            correlationId: cid,
            err: err instanceof Error ? err.message : "unknown",
          },
          "trade history query failed"
        );
        return reply.code(503).send({
          code: ERR.UNAVAILABLE,
          message: "Trade data temporarily unavailable",
          correlationId: cid,
        });
      }
    }
  );
};
