import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import type { Market, MarketStatus } from "../../types/index.js";
import { heavyReadLimiter } from "../middleware/rateLimiter.js";
import { success } from "../middleware/responses.js";

interface GetMarketsQueryParams {
  status?: MarketStatus;
}

interface GetMarketsResponse {
  markets: Market[];
  count: number;
}

export async function marketsRoutes(fastify: FastifyInstance) {
  const prisma = getPrismaClient();

  // Heavy read: full-table scan with optional status filter — apply stricter limit.
  fastify.get<{ Querystring: GetMarketsQueryParams }>(
    "/markets",
    {
      onRequest: [heavyReadLimiter],
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
    async (request: FastifyRequest<{ Querystring: GetMarketsQueryParams }>, reply) => {
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

      success(reply, response);
    }
  );
}
