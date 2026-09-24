import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../../src/services/prisma.js";
import type { Prisma, OrderStatus } from "../../../src/generated/prisma/client";

interface GetOrdersQuery {
  status?: string;
  page?: number;
  limit?: number;
}

interface GetOrderParams {
  id: string;
}

/**
 * RATE_LIMIT_POLICY.md: external read entrypoints are rate limited per client
 * identity (authenticated subject when present, otherwise source IP). Limits
 * are enforced fail-closed: if the limiter backend is unavailable the request
 * is rejected rather than allowed through.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

function clientIdentity(request: FastifyRequest): string {
  const subject = (request as FastifyRequest & { user?: { sub?: string } }).user
    ?.sub;
  if (typeof subject === "string" && subject.length > 0) {
    return `sub:${subject}`;
  }
  return `ip:${request.ip}`;
}

function enforceRateLimit(request: FastifyRequest, reply: { status: (code: number) => { send: (body: unknown) => unknown } }): boolean {
  const now = Date.now();
  const key = clientIdentity(request);
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    reply
      .status(429)
      .send({
        error: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests",
        correlationId: request.id,
        retryAfter,
      });
    return false;
  }

  bucket.count += 1;
  return true;
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
    async (request: FastifyRequest<{ Querystring: GetOrdersQuery }>, reply) => {
      if (!enforceRateLimit(request, reply)) {
        return;
      }

      const { status, page = 1, limit = 20 } = request.query;
      const where: Prisma.OrderWhereInput = status
        ? { status: status as OrderStatus }
        : {};
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
      if (!enforceRateLimit(request, reply)) {
        return;
      }

      const { id } = request.params;

      const order = await prisma.order.findUnique({ where: { id } });
      if (!order) {
        return reply.status(404).send({ error: "Order not found" });
      }

      reply.status(200).send({ order });
    }
  );
}
