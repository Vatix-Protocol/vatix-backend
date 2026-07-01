import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../../src/services/prisma.js";

interface GetOrdersQuery {
  status?: string;
  page?: number;
  limit?: number;
}

interface GetOrderParams {
  id: string;
}

export async function ordersRoutes(fastify: FastifyInstance) {
  const prisma = getPrismaClient();

  fastify.get<{ Querystring: GetOrdersQuery }>(
    "/orders",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["OPEN", "FILLED", "CANCELLED", "PARTIALLY_FILLED"],
            },
            page: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: GetOrdersQuery }>,
      reply
    ) => {
      const { status, page = 1, limit = 20 } = request.query;
      const where = status ? { status } : {};
      const skip = (page - 1) * limit;

      const [orders, total] = await Promise.all([
        prisma.order.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip,
          take: limit,
        }),
        prisma.order.count({ where }),
      ]);

      reply.status(200).send({
        orders,
        total,
        hasNext: skip + orders.length < total,
        page,
        limit,
      });
    }
  );

  fastify.get<{ Params: GetOrderParams }>(
    "/orders/:id",
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
    async (request: FastifyRequest<{ Params: GetOrderParams }>, reply) => {
      const { id } = request.params;

      const order = await prisma.order.findUnique({ where: { id } });
      if (!order) {
        return reply.status(404).send({ error: "Order not found" });
      }

      reply.status(200).send({ order });
    }
  );
}
