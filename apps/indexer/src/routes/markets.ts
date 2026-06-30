import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../../../src/services/prisma.js";

interface GetMarketsQuery {
  status?: string;
  limit?: number;
}

interface GetMarketParams {
  id: string;
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
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: GetMarketsQuery }>,
      reply
    ) => {
      const { status, limit = 50 } = request.query;
      const where = status ? { status } : {};

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

      const market = await prisma.market.findUnique({ where: { id } });
      if (!market) {
        return reply.status(404).send({ error: "Market not found" });
      }

      reply.status(200).send({ market });
    }
  );
}
