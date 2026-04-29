import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import type { Market, MarketStatus } from "../../types/index.js";
import { heavyReadLimiter } from "../middleware/rateLimiter.js";
import { success } from "../middleware/responses.js";
import { MarketNotFoundError } from "../middleware/errors.js";

interface GetMarketsQueryParams {
  status?: MarketStatus;
  sort?: "createdAt" | "endTime";
  direction?: "asc" | "desc";
  limit?: number;
}

interface GetMarketsResponse {
  markets: Market[];
  count: number;
}

interface GetMarketParams {
  id: string;
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
            sort: {
              type: "string",
              enum: ["createdAt", "endTime"],
            },
            direction: {
              type: "string",
              enum: ["asc", "desc"],
              default: "desc",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 50,
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
      const { status, sort = "createdAt", direction = "desc", limit = 50 } = request.query;

      const whereClause = status ? { status } : {};

      const orderBy = {
        [sort]: direction,
      };

      const markets = await prisma.market.findMany({
        where: whereClause,
        orderBy,
        take: limit,
      });

      const response: GetMarketsResponse = {
        markets,
        count: markets.length,
      };

      success(reply, response);
    }
  );

  // Get single market by ID
  fastify.get<{ Params: GetMarketParams }>(
    "/markets/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
        response: {
          200: {
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
      },
    },
    async (request: FastifyRequest<{ Params: GetMarketParams }>, reply) => {
      const { id } = request.params;

      const market = await prisma.market.findUnique({
        where: { id },
      });

      if (!market) {
        throw new MarketNotFoundError(id);
      }

      success(reply, market);
    }
  );
}
