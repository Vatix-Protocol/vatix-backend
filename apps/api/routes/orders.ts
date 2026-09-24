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

interface CreateOrderBody {
  marketId: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  price?: string;
  amount: string;
  idempotencyKey?: string;
}

interface CancelOrderParams {
  id: string;
}

interface CancelOrderBody {
  idempotencyKey?: string;
}

const ORDER_STATUSES = ["OPEN", "FILLED", "CANCELLED", "PARTIALLY_FILLED"] as const;

// Stable error codes for the orders API surface.
const ERR = {
  UNAUTHORIZED: "ORDERS_UNAUTHORIZED",
  FORBIDDEN: "ORDERS_FORBIDDEN",
  NOT_FOUND: "ORDERS_NOT_FOUND",
  VALIDATION: "ORDERS_VALIDATION_FAILED",
  CONFLICT: "ORDERS_IDEMPOTENCY_CONFLICT",
  UNAVAILABLE: "ORDERS_DEPENDENCY_UNAVAILABLE",
} as const;

function correlationId(request: FastifyRequest): string {
  const header = request.headers["x-correlation-id"];
  if (typeof header === "string" && header.length > 0 && header.length <= 128) {
    return header;
  }
  return request.id;
}

function fail(
  reply: any,
  status: number,
  code: string,
  message: string,
  correlation: string
) {
  return reply.status(status).send({ error: { code, message, correlationId: correlation } });
}

// Deny-by-default authz: privileged order writes require an authenticated
// principal with an allowed role. Untrusted clients cannot bypass policy.
function authorizeWrite(request: FastifyRequest): { ok: true; actor: string } | { ok: false; status: number; code: string; message: string } {
  const user = (request as any).user;
  if (!user || typeof user.id !== "string" || user.id.length === 0) {
    return { ok: false, status: 401, code: ERR.UNAUTHORIZED, message: "Authentication required" };
  }
  const role = user.role;
  if (role !== "TRADER" && role !== "ADMIN") {
    return { ok: false, status: 403, code: ERR.FORBIDDEN, message: "Insufficient role for order writes" };
  }
  return { ok: true, actor: user.id };
}

// Fail-closed: writes must not proceed when a dependency is unavailable.
async function dependencyHealthy(prisma: ReturnType<typeof getPrismaClient>): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
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
              enum: [...ORDER_STATUSES],
            },
            page: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: GetOrdersQuery }>, reply) => {
      const correlation = correlationId(request);
      const { status, page = 1, limit = 20 } = request.query;
      const where = status ? { status } : {};
      const skip = (page - 1) * limit;

      try {
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
          correlationId: correlation,
        });
      } catch {
        return fail(reply, 503, ERR.UNAVAILABLE, "Orders store unavailable", correlation);
      }
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
            id: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: GetOrderParams }>, reply) => {
      const correlation = correlationId(request);
      const { id } = request.params;

      try {
        const order = await prisma.order.findUnique({ where: { id } });
        if (!order) {
          return fail(reply, 404, ERR.NOT_FOUND, "Order not found", correlation);
        }

        reply.status(200).send({ order, correlationId: correlation });
      } catch {
        return fail(reply, 503, ERR.UNAVAILABLE, "Orders store unavailable", correlation);
      }
    }
  );

  fastify.post<{ Body: CreateOrderBody }>(
    "/orders",
    {
      schema: {
        body: {
          type: "object",
          required: ["marketId", "side", "type", "amount"],
          additionalProperties: false,
          properties: {
            marketId: { type: "string", minLength: 1, maxLength: 128 },
            side: { type: "string", enum: ["BUY", "SELL"] },
            type: { type: "string", enum: ["LIMIT", "MARKET"] },
            price: { type: "string", pattern: "^[0-9]+(\\.[0-9]+)?$" },
            amount: { type: "string", pattern: "^[0-9]+(\\.[0-9]+)?$" },
            idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateOrderBody }>, reply) => {
      const correlation = correlationId(request);

      const auth = authorizeWrite(request);
      if (!auth.ok) {
        return fail(reply, auth.status, auth.code, auth.message, correlation);
      }

      const body = request.body;
      if (body.type === "LIMIT" && !body.price) {
        return fail(reply, 400, ERR.VALIDATION, "price is required for LIMIT orders", correlation);
      }

      if (!(await dependencyHealthy(prisma))) {
        return fail(reply, 503, ERR.UNAVAILABLE, "Orders store unavailable", correlation);
      }

      try {
        // Idempotency: replay of the same key returns the existing order
        // instead of creating a duplicate.
        if (body.idempotencyKey) {
          const existing = await prisma.order.findFirst({
            where: { idempotencyKey: body.idempotencyKey },
          });
          if (existing) {
            return reply.status(200).send({ order: existing, correlationId: correlation });
          }
        }

        const order = await prisma.order.create({
          data: {
            marketId: body.marketId,
            side: body.side,
            type: body.type,
            price: body.price ?? null,
            amount: body.amount,
            status: "OPEN",
            userId: auth.actor,
            idempotencyKey: body.idempotencyKey ?? null,
          },
        });

        reply.status(201).send({ order, correlationId: correlation });
      } catch (err: any) {
        // Unique constraint on idempotencyKey => concurrent duplicate request.
        if (err?.code === "P2002") {
          const existing = body.idempotencyKey
            ? await prisma.order.findFirst({ where: { idempotencyKey: body.idempotencyKey } })
            : null;
          if (existing) {
            return reply.status(200).send({ order: existing, correlationId: correlation });
          }
          return fail(reply, 409, ERR.CONFLICT, "Duplicate order request", correlation);
        }
        return fail(reply, 503, ERR.UNAVAILABLE, "Orders store unavailable", correlation);
      }
    }
  );

  fastify.post<{ Params: CancelOrderParams; Body: CancelOrderBody }>(
    "/orders/:id/cancel",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CancelOrderParams; Body: CancelOrderBody }>, reply) => {
      const correlation = correlationId(request);

      const auth = authorizeWrite(request);
      if (!auth.ok) {
        return fail(reply, auth.status, auth.code, auth.message, correlation);
      }

      if (!(await dependencyHealthy(prisma))) {
        return fail(reply, 503, ERR.UNAVAILABLE, "Orders store unavailable", correlation);
      }

      const { id } = request.params;

      try {
        const order = await prisma.order.findUnique({ where: { id } });
        if (!order) {
          return fail(reply, 404, ERR.NOT_FOUND, "Order not found", correlation);
        }

        // Ownership check: only the owner or an admin may cancel.
        const user = (request as any).user;
        if (user.role !== "ADMIN" && order.userId !== auth.actor) {
          return fail(reply, 403, ERR.FORBIDDEN, "Not authorized to cancel this order", correlation);
        }

        if (order.status === "CANCELLED") {
          return reply.status(200).send({ order, correlationId: correlation });
        }
        if (order.status === "FILLED") {
          return fail(reply, 409, ERR.CONFLICT, "Filled orders cannot be cancelled", correlation);
        }

        const updated = await prisma.order.update({
          where: { id },
          data: { status: "CANCELLED" },
        });

        reply.status(200).send({ order: updated, correlationId: correlation });
      } catch {
        return fail(reply, 503, ERR.UNAVAILABLE, "Orders store unavailable", correlation);
      }
    }
  );
}
