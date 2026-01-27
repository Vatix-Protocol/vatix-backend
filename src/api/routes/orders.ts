import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import { ValidationError } from "../middleware/errors.js";
import type { OrderStatus } from "../../types/index.js";
import { validateUserAddress } from "../../matching/validation.js";

interface GetUserOrdersParams {
  address: string;
}

interface GetUserOrdersQuery {
  status?: OrderStatus;
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
      }>,
    ) => {
      const { address } = request.params;
      const { status } = request.query;

      // Validate Stellar address
      const addressError = validateUserAddress(address);
      if (addressError) {
        throw new ValidationError(addressError);
      }

      try {
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
      } catch (error) {
        request.log.error(
          { error, address, status },
          "Failed to fetch user orders",
        );
        throw new Error("Failed to fetch user orders");
      }
    },
  );
}
