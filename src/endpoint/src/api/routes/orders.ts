/**
 * Orders API routes
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { OrderRequest, OrderResponse } from "../../types/requests";
import { OrderController } from "../../interfaces/services";

export interface OrderRouteOptions {
  orderController: OrderController;
}

export async function orderRoutes(
  fastify: FastifyInstance,
  options: OrderRouteOptions,
) {
  const { orderController } = options;

  // POST /orders - Submit a new order
  fastify.post<{
    Body: Omit<OrderRequest, "userAddress">;
    Reply: OrderResponse;
  }>(
    "/orders",
    {
      schema: {
        body: {
          type: "object",
          required: ["marketId", "side", "outcome", "quantity"],
          properties: {
            marketId: { type: "string" },
            side: { type: "string", enum: ["buy", "sell"] },
            outcome: { type: "string" },
            price: { type: "number", minimum: 0 },
            quantity: { type: "number", minimum: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              orderId: { type: "string" },
              receipt: { type: "object" },
              trades: { type: "array" },
            },
          },
          400: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              error: { type: "object" },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Extract user address from authentication headers
        const userAddress = request.headers["x-user-address"] as string;

        if (!userAddress) {
          return reply.status(401).send({
            success: false,
            error: {
              code: "AUTHENTICATION_REQUIRED",
              message: "User address required in headers",
              timestamp: new Date().toISOString(),
              requestId: request.id,
            },
          });
        }

        const orderRequest: OrderRequest = {
          ...(request.body as Omit<OrderRequest, "userAddress">),
          userAddress,
        };

        const result = await orderController.submitOrder(orderRequest);

        if (result.success) {
          return reply.status(200).send(result);
        } else {
          return reply.status(400).send(result);
        }
      } catch (error) {
        request.log.error(error, "Error processing order submission");

        return reply.status(500).send({
          success: false,
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "An internal error occurred",
            timestamp: new Date().toISOString(),
            requestId: request.id,
          },
        });
      }
    },
  );
}
