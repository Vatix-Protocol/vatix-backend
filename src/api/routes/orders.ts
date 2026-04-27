import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import { ValidationError } from "../middleware/errors.js";
import type { OrderSide, Outcome, OrderStatus } from "../../types/index.js";
import {
  validateUserAddress,
  assertValidOrder,
  type OrderInput,
} from "../../matching/validation.js";

interface GetUserOrdersParams {
  address: string;
}

interface GetUserOrdersQuery {
  status?: OrderStatus;
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

  fastify.get<{
    Params: GetUserOrdersParams;
    Querystring: GetUserOrdersQuery;
  }>(
    "/orders/user/:address",
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
            status: {
              type: "string",
              enum: ["OPEN", "FILLED", "CANCELLED", "PARTIALLY_FILLED"],
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
              count: { type: "number" },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: GetUserOrdersParams;
        Querystring: GetUserOrdersQuery;
      }>
    ) => {
      const { address } = request.params;
      const { status } = request.query;

      // Validate Stellar address
      const addressError = validateUserAddress(address);
      if (addressError) {
        throw new ValidationError(addressError);
      }

      const whereClause = {
        userAddress: address,
        ...(status ? { status } : {}),
      };

      const orders = await prisma.order.findMany({
        where: whereClause,
        orderBy: {
          createdAt: "desc",
        },
      });

      return {
        orders,
        count: orders.length,
      };
    }
  );

  // POST /orders
  fastify.post<{ Body: CreateOrderBody }>(
    "/orders",
    {
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

      reply.code(201);
      return { order };
    }
  );
}
