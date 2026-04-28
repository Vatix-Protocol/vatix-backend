import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import { ValidationError } from "../middleware/errors.js";
import type { OrderSide, Outcome, OrderStatus } from "../../types/index.js";
import { auditService } from "../../services/audit.js";
import {
  validateUserAddress,
  assertValidOrder,
  type OrderInput,
} from "../../matching/validation.js";
import {
  heavyReadLimiter,
  writeLimiter,
} from "../middleware/rateLimiter.js";
import { success } from "../middleware/responses.js";

interface GetUserOrdersParams {
  address: string;
}

interface GetUserOrdersQuery {
  status?: OrderStatus;
  page?: number;
  limit?: number;
}

interface GetWalletTradesQuery {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
}

interface CreateOrderBody {
  marketId: string;
  userAddress: string;
  side: OrderSide;
  outcome: Outcome;
  price: number;
  quantity: number;
}

export async function ordersRoutes(fastify: FastifyInstance) {
  const prisma = getPrismaClient();

  // Heavy read: two DB queries (findMany + count) per request — apply stricter limit.
  fastify.get<{
    Params: GetUserOrdersParams;
    Querystring: GetWalletTradesQuery;
  }>(
    "/trades/user/:address",
    {
      schema: {
        params: {
          type: "object",
          required: ["address"],
          properties: {
            address: { type: "string" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            page: {
              type: "integer",
              minimum: 1,
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
            },
            from: {
              type: "string",
              format: "date-time",
              description:
                "Inclusive UTC start timestamp (ISO-8601), e.g. 2026-04-27T00:00:00.000Z",
            },
            to: {
              type: "string",
              format: "date-time",
              description:
                "Inclusive UTC end timestamp (ISO-8601), e.g. 2026-04-27T23:59:59.999Z",
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: GetUserOrdersParams;
        Querystring: GetWalletTradesQuery;
      }>
    ) => {
      const { address } = request.params;
      const { page = 1, limit = 20, from, to } = request.query;

      const addressError = validateUserAddress(address);
      if (addressError) {
        throw new ValidationError(addressError);
      }

      let fromMs: number | undefined;
      let toMs: number | undefined;

      if (from !== undefined) {
        fromMs = Date.parse(from);
        if (Number.isNaN(fromMs)) {
          throw new ValidationError("from must be a valid UTC ISO-8601 timestamp");
        }
      }

      if (to !== undefined) {
        toMs = Date.parse(to);
        if (Number.isNaN(toMs)) {
          throw new ValidationError("to must be a valid UTC ISO-8601 timestamp");
        }
      }

      if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
        throw new ValidationError(
          "Invalid date range: from must be earlier than or equal to to"
        );
      }

      const { trades, total, hasNext } = await auditService.getWalletTradeHistory(
        address,
        page,
        limit,
        fromMs,
        toMs
      );

      return {
        trades: trades.map((entry) => ({
          id: entry.trade.id,
          marketId: entry.trade.marketId,
          outcome: entry.trade.outcome,
          buyerAddress: entry.trade.buyerAddress,
          sellerAddress: entry.trade.sellerAddress,
          buyOrderId: entry.trade.buyOrderId,
          sellOrderId: entry.trade.sellOrderId,
          price: entry.trade.price,
          quantity: entry.trade.quantity,
          timestamp: entry.trade.timestamp,
          loggedAt: entry.loggedAt,
        })),
        total,
        hasNext,
        page,
        limit,
      };
    }
  );

  fastify.get<{
    Params: GetUserOrdersParams;
    Querystring: GetUserOrdersQuery;
  }>(
    "/orders/user/:address",
    {
      onRequest: [heavyReadLimiter],
      schema: {
        params: {
          type: "object",
          required: ["address"],
          properties: {
            address: { type: "string" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["OPEN", "FILLED", "CANCELLED", "PARTIALLY_FILLED"],
            },
            page: {
              type: "integer",
              minimum: 1,
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              orders: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    marketId: { type: "string" },
                    userAddress: { type: "string" },
                    side: { type: "string" },
                    outcome: { type: "string" },
                    price: { type: "string" },
                    quantity: { type: "number" },
                    filledQuantity: { type: "number" },
                    status: { type: "string" },
                    createdAt: { type: "string" },
                  },
                },
              },
              total: { type: "number" },
              hasNext: { type: "boolean" },
              page: { type: "number" },
              limit: { type: "number" },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: GetUserOrdersParams;
        Querystring: GetUserOrdersQuery;
      }>,
      reply
    ) => {
      const { address } = request.params;
      const { status, page = 1, limit = 20 } = request.query;

      // Validate Stellar address
      const addressError = validateUserAddress(address);
      if (addressError) {
        throw new ValidationError(addressError);
      }

      const whereClause = {
        userAddress: address,
        ...(status ? { status } : {}),
      };

      const skip = (page - 1) * limit;

      const [orders, total] = await Promise.all([
        prisma.order.findMany({
          where: whereClause,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip,
          take: limit,
        }),
        prisma.order.count({
          where: whereClause,
        }),
      ]);

      success(reply, {
        orders,
        total,
        hasNext: skip + orders.length < total,
        page,
        limit,
      });
    }
  );

  // Write endpoint: validation + DB write + future matching-engine work — apply strictest limit.
  fastify.post<{ Body: CreateOrderBody }>(
    "/orders",
    {
      onRequest: [writeLimiter],
      schema: {
        body: {
          type: "object",
          required: [
            "marketId",
            "userAddress",
            "side",
            "outcome",
            "price",
            "quantity",
          ],
          properties: {
            marketId: { type: "string" },
            userAddress: { type: "string" },
            side: {
              type: "string",
              enum: ["BUY", "SELL"],
            },
            outcome: {
              type: "string",
              enum: ["YES", "NO"],
            },
            price: {
              type: "number",
              exclusiveMinimum: 0,
              exclusiveMaximum: 1,
            },
            quantity: {
              type: "integer",
              minimum: 1,
            },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              order: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  marketId: { type: "string" },
                  userAddress: { type: "string" },
                  side: { type: "string" },
                  outcome: { type: "string" },
                  price: { type: "string" },
                  quantity: { type: "number" },
                  filledQuantity: { type: "number" },
                  status: { type: "string" },
                  createdAt: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateOrderBody }>, reply) => {
      const { marketId, userAddress, side, outcome, price, quantity } =
        request.body;

      // Validate order using existing validation
      const orderInput: OrderInput = {
        marketId,
        userAddress,
        side,
        outcome,
        price,
        quantity,
      };

      // This throws OrderValidationError if invalid
      // Validates: address format, market exists/active, price range, quantity > 0
      await assertValidOrder(orderInput);

      // Create order in database
      const order = await prisma.order.create({
        data: {
          marketId,
          userAddress,
          side,
          outcome,
          price: price.toString(),
          quantity,
          filledQuantity: 0,
          status: "OPEN",
        },
      });

      // TODO: Add to matching engine
      // await matchingEngine.addOrder(order);

      success(reply, { order }, 201);
    }
  );
}
