import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import type { Market, MarketStatus, Outcome } from "../../types/index.js";
import { heavyReadLimiter } from "../middleware/rateLimiter.js";
import { success } from "../middleware/responses.js";
import { NotFoundError } from "../middleware/errors.js";
import type {
  MarketDetailsDto,
  MarketListItemDto,
  MarketOrderBookDto,
  OrderBookLevelDto,
} from "./market.dto.js";

interface GetMarketsQueryParams {
  status?: MarketStatus;
}

interface GetMarketsResponse {
  markets: MarketListItemDto[];
  count: number;
}

interface GetMarketParams {
  id: string;
}

interface GetMarketResponse {
  market: MarketDetailsDto;
}

interface GetMarketOrderbookResponse {
  orderbook: MarketOrderBookDto;
}

const OPEN_ORDER_STATUSES = ["OPEN", "PARTIALLY_FILLED"] as const;

function toMarketDto(market: Market): MarketDetailsDto {
  return {
    id: market.id,
    question: market.question,
    endTime: market.endTime.toISOString(),
    resolutionTime: market.resolutionTime?.toISOString() ?? null,
    oracleAddress: market.oracleAddress,
    status: market.status,
    outcome: market.outcome,
    createdAt: market.createdAt.toISOString(),
    updatedAt: market.updatedAt.toISOString(),
  };
}

function createDepthLevel(
  price: number,
  outcome: Outcome,
  totalQuantity: number,
  orderCount: number
): OrderBookLevelDto {
  return { price, outcome, totalQuantity, orderCount };
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
      },
    },
    async (
      request: FastifyRequest<{ Querystring: GetMarketsQueryParams }>,
      reply
    ) => {
      const { status } = request.query;

      const whereClause = status ? { status } : {};

      const markets = await prisma.market.findMany({
        where: whereClause,
        orderBy: {
          createdAt: "desc",
        },
      });

      const response: GetMarketsResponse = {
        markets: markets.map(toMarketDto),
        count: markets.length,
      };

      success(reply, response);
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
        throw new NotFoundError(`Market not found: ${id}`);
      }

      success(reply, { market: toMarketDto(market) });
    }
  );

  fastify.get<{ Params: GetMarketParams }>(
    "/markets/:id/orderbook",
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
        throw new NotFoundError(`Market not found: ${id}`);
      }

      const openOrders = await prisma.order.findMany({
        where: {
          marketId: id,
          status: {
            in: OPEN_ORDER_STATUSES,
          },
        },
        select: {
          side: true,
          outcome: true,
          price: true,
          quantity: true,
          filledQuantity: true,
        },
      });

      const orderBookLevels = new Map<
        string,
        {
          side: "BUY" | "SELL";
          price: number;
          outcome: Outcome;
          totalQuantity: number;
          orderCount: number;
        }
      >();

      for (const order of openOrders) {
        const remainingQuantity = order.quantity - order.filledQuantity;
        if (remainingQuantity <= 0) continue;

        const price = Number(order.price);
        const key = `${order.side}:${order.outcome}:${price}`;
        const existing = orderBookLevels.get(key);

        if (existing) {
          existing.totalQuantity += remainingQuantity;
          existing.orderCount += 1;
        } else {
          orderBookLevels.set(key, {
            side: order.side,
            price,
            outcome: order.outcome,
            totalQuantity: remainingQuantity,
            orderCount: 1,
          });
        }
      }

      const depthEntries = Array.from(orderBookLevels.values());

      const bids = depthEntries
        .filter((entry) => entry.side === "BUY")
        .sort((a, b) => b.price - a.price)
        .map((entry) =>
          createDepthLevel(
            entry.price,
            entry.outcome,
            entry.totalQuantity,
            entry.orderCount
          )
        );

      const asks = depthEntries
        .filter((entry) => entry.side === "SELL")
        .sort((a, b) => a.price - b.price)
        .map((entry) =>
          createDepthLevel(
            entry.price,
            entry.outcome,
            entry.totalQuantity,
            entry.orderCount
          )
        );

      const orderbook: MarketOrderBookDto = {
        marketId: id,
        snapshotTimestamp: new Date().toISOString(),
        ledgerSequence: null,
        bids,
        asks,
      };

      success(reply, { orderbook });
    }
  );
}
