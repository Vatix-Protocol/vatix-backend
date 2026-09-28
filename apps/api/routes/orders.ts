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
  PAYLOAD_TOO_LARGE: "ORDERS_PAYLOAD_TOO_LARGE",
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

/**
 * BODY_LIMIT_POLICY.md: external HTTP entrypoints enforce a configurable
 * maximum request body size. Oversized bodies are rejected fail-closed with
 * HTTP 413 and a stable error code before any handler logic runs. The limit is
 * configurable via ORDERS_MAX_BODY_BYTES and defaults to 64 KiB.
 */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

function maxBodyBytes(): number {
  const raw = process.env.ORDERS_MAX_BODY_BYTES;
  if (typeof raw === "string" && raw.length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_BODY_BYTES;
}

/**
 * Reusable body-limit guard. Returns true when the request may proceed and
 * false when it has already been rejected with a stable error code and
 * correlation id. Content-Length is checked first (cheap, fail-closed); when
 * absent the declared limit is still enforced by the server parser.
 */
function enforceBodyLimit(
  request: FastifyRequest,
  reply: { status: (code: number) => { send: (body: unknown) => unknown } }
): boolean {
  const limit = maxBodyBytes();
  const header = request.headers["content-length"];
  if (typeof header === "string" && header.length > 0) {
    const declared = Number.parseInt(header, 10);
    if (Number.isFinite(declared) && declared > limit) {
      reply.status(413).send({
        error: {
          code: ERR.PAYLOAD_TOO_LARGE,
          message: "Request body exceeds the maximum allowed size",
          correlationId: correlationId(request),
          maxBytes: limit,
        },
      });
      return false;
    }
  }
  return true;
}

export async function ordersRoutes(fastify: FastifyInstance) {
  const prisma = getPrismaClient();

  // Enforce the body-size policy at the plugin boundary so every route in this
  // surface (including future privileged ones) is covered deny-by-default.
  fastify.addHook("onRequest", async (request, reply) => {
    if (!enforceBodyLimit(request, reply)) {
      return reply;
    }
  });

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
      if (!enforceRateLimit(request, reply)) {
        return;
      }

      const correlation = correlationId(request);

      const { status, page = 1, limit = 20 } = request.query;
      const where: Prisma.OrderWhereInput = status
        ? { status: status as OrderStatus }
        : {};
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
      if (!enforceRateLimit(request, reply)) {
        return;
      }

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
          const existing = await prisma.o

/* … truncated 3462 chars — edit only what you need near the top … */
