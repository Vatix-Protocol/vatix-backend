import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import type { Market, MarketStatus } from "../../types/index.js";

interface GetMarketsQueryParams {
  status?: MarketStatus;
}

interface GetMarketsResponse {
  markets: Market[];
  count: number;
}

export async function marketsRoutes(fastify: FastifyInstance) {
  const prisma = getPrismaClient();

  fastify.get<{ Querystring: GetMarketsQueryParams }>(
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
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              markets: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    question: { type: "string" },
                    endTime: { type: "string" },
                    resolutionTime: { type: ["string", "null"] },
                    oracleAddress: { type: "string" },
                    status: { type: "string" },
                    outcome: { type: ["boolean", "null"] },
                    createdAt: { type: "string" },
                    updatedAt: { type: "string" },
                  },
                },
              },
              count: { type: "number" },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: GetMarketsQueryParams }>) => {
      const { status } = request.query;

      const whereClause = status ? { status } : {};

      const markets = await prisma.market.findMany({
        where: whereClause,
        orderBy: {
          createdAt: "desc",
        },
      });

      const response: GetMarketsResponse = {
        markets,
        count: markets.length,
      };

      return response;
    },
  );
}
