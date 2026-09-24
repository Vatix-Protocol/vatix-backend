import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../../../src/services/prisma.js";

interface GetMarketsQuery {
  status?: string;
  limit?: number;
  includeDeleted?: boolean;
}

interface GetMarketParams {
  id: string;
}

/**
 * Soft-deleted markets must never be surfaced on read/money-path endpoints.
 * A market is considered soft-deleted when its `deletedAt` timestamp is set.
 * Fail-closed: if the deletion status is unknown/unavailable we exclude the
 * market rather than risk surfacing a deleted market.
 */
function notDeletedFilter() {
  return { deletedAt: null };
}

export async function marketsRoutes(fastify: FastifyInstance) {
  const prisma = getPrismaClient();

  fastify.get<{ Querystring: GetMarketsQuery }>(
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
            limit: { type: "integer", minimum: 1, maximum: 100 },
            includeDeleted: { type: "boolean", default: false },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: GetMarketsQuery }>,
      reply
    ) => {
      const { status, limit = 50, includeDeleted = false } = request.query;

      // Soft-deleted markets are excluded by default. Only an explicit
      // includeDeleted=true (privileged/admin surface) may surface them.
      const where = {
        ...(status ? { status } : {}),
        ...(includeDeleted ? {} : notDeletedFilter()),
      };

      const markets = await prisma.market.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      reply.status(200).send({
        markets,
        count: markets.length,
      });
    }
  );

  fastify.get<{ Params: GetMarketParams }>(
    "/markets/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: GetMarketParams }>, reply) => {
      const { id } = request.params;

      // Fail-closed: a soft-deleted market is treated as not found so it is
      // never surfaced on single-market lookups.
      const market = await prisma.market.findFirst({
        where: { id, ...notDeletedFilter() },
      });
      if (!market) {
        return reply.status(404).send({ error: "Market not found" });
      }

      reply.status(200).send({ market });
    }
  );
}
