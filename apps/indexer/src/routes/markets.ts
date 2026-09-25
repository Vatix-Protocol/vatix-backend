import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../../src/services/prisma.js";
import type { MarketStatus } from "../../../src/generated/prisma/client.js";
import { NOT_SOFT_DELETED } from "../storage.js";

// Stable error codes for the markets read API surface.
const ERR = {
  NOT_FOUND: "MARKETS_NOT_FOUND",
  VALIDATION: "MARKETS_VALIDATION_FAILED",
  UNAVAILABLE: "MARKETS_DEPENDENCY_UNAVAILABLE",
} as const;

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

interface GetMarketParams {
  id: string;
}

export const marketsRoutes = async function (
  app: FastifyInstance,
): Promise<void> {
  app.get<{ Querystring: GetMarketsQuery }>(
    "/markets",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["ACTIVE", "RESOLVED", "CANCELLED"],
            },
            cursor: { type: "string", nullable: true },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              nullable: true,
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const cid = correlationId(request);
      const { status, cursor, limit } = request.query;

      const parsedLimit = limit ?? 20;

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
        const [markets, total] = await Promise.all([
          prisma.market.findMany({
            where,
            orderBy: { createdAt: "desc" },
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
          }),
          prisma.market.count({ where }),
        ]);

        const hasMore = markets.length > parsedLimit;
        const items = hasMore ? markets.slice(0, parsedLimit) : markets;
        const nextCursor = hasMore ? items[items.length - 1].id : null;

        return reply.code(200).send({
          markets: items,
          count: items.length,
          total,
          nextCursor,
          correlationId: cid,
        });
      } catch (err) {
        request.log.error(
          { correlationId: cid, err: err instanceof Error ? err.message : "unknown" },
          "markets list query failed",
        );
        return reply.code(503).send({
          code: ERR.UNAVAILABLE,
          message: "Market data temporarily unavailable",
          correlationId: cid,
        });
      }
    },
  );

  app.get<{ Params: GetMarketParams }>(
    "/markets/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const cid = correlationId(request);
      const { id } = request.params;

      try {
        const prisma = getPrismaClient();
        const market = await prisma.market.findUnique({
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
        });

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
          { correlationId: cid, err: err instanceof Error ? err.message : "unknown" },
          "market lookup failed",
        );
        return reply.code(503).send({
          code: ERR.UNAVAILABLE,
          message: "Market data temporarily unavailable",
          correlationId: cid,
        });
      }
    },
  );
};