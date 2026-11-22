import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { getPrismaClient } from "../../services/prisma.js";
import {
  ValidationError,
  NotFoundError,
  IdempotencyConflictError,
} from "../middleware/errors.js";
import type { OrderSide, Outcome, OrderStatus } from "../../types/index.js";
import { auditService } from "../../services/audit.js";
import { redis } from "../../services/redis.js";
import { matchingService } from "../../matching/matching-service.js";
import {
  validateUserAddress,
  isValidStellarPublicKey,
  sanitizeUserAddress,
  assertValidOrder,
  validateTickSize,
  TICK_SIZE,
  STELLAR_PUBLIC_KEY_REGEX,
  type OrderInput,
} from "../../matching/validation.js";
import { heavyReadLimiter, writeLimiter } from "../middleware/rateLimiter.js";
import {
  verifyStellarSignature,
  verifyStellarCancellationSignature,
} from "../middleware/stellarAuth.js";

// ---------------------------------------------------------------------------
// Zod schema for POST /orders body
// ---------------------------------------------------------------------------

export const CreateOrderSchema = z
  .object({
    marketId: z.string().min(1, "marketId is required"),
    userAddress: z
      .string()
      .regex(
        STELLAR_PUBLIC_KEY_REGEX,
        "userAddress must be a valid Stellar address (public key)"
      )
      .refine(isValidStellarPublicKey, {
        message: "userAddress must be a valid Stellar address (public key)",
      }),
    side: z.enum(["BUY", "SELL"]),
    outcome: z.enum(["YES", "NO"]),
    // price 0 marks a market order; the matcher derives the cap from limitPrice.
    price: z
      .number()
      .gte(0, "price must be greater than or equal to 0")
      .lt(1, "price must be less than 1")
      .refine((val) => val === 0 || validateTickSize(val) === null, {
        message: `price must be a multiple of ${TICK_SIZE} (e.g. 0.01, 0.50, 0.99)`,
      }),
    quantity: z
      .number()
      .int("quantity must be an integer")
      .min(1, "quantity must be at least 1"),
    limitPrice: z
      .number()
      .gt(0, "limitPrice must be greater than 0")
      .lt(1, "limitPrice must be less than 1")
      .refine((val) => validateTickSize(val) === null, {
        message: `limitPrice must be a multiple of ${TICK_SIZE} (e.g. 0.01, 0.50, 0.99)`,
      })
      .optional(),
    maxSlippagePct: z
      .number()
      .gte(0, "maxSlippagePct must be greater than or equal to 0")
      .lte(100, "maxSlippagePct must be less than or equal to 100")
      .optional(),
    allowPartialFill: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.price === 0 && val.limitPrice === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["limitPrice"],
        message: "limitPrice is required for a market order (price 0)",
      });
    }
  });

export type CreateOrderBody = z.infer<typeof CreateOrderSchema>;

// ---------------------------------------------------------------------------
// Idempotency-Key handling for POST /orders (see RATE_LIMIT_POLICY.md)
// ---------------------------------------------------------------------------

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Returns the mandatory Idempotency-Key header (#1461). A missing header is a
 * 400 naming the header, so a create can never be written without a key to
 * replay it under. Malformed values are rejected the same way.
 */
export function parseIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers["idempotency-key"];
  if (raw === undefined) {
    const message = "Idempotency-Key header is required";
    throw new ValidationError(message, { "Idempotency-Key": message });
  }
  if (typeof raw !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    const message =
      "Idempotency-Key must be 1-128 characters of A-Z, a-z, 0-9, '_', '-', '.', ':'";
    throw new ValidationError(message, { "Idempotency-Key": message });
  }
  return raw;
}

/** SHA-256 of the validated order payload, used to detect key reuse. */
export function hashOrderRequest(body: CreateOrderBody): string {
  const {
    marketId,
    userAddress,
    side,
    outcome,
    price,
    quantity,
    limitPrice,
    maxSlippagePct,
    allowPartialFill,
  } = body;
  return createHash("sha256")
    .update(
      JSON.stringify({
        marketId,
        userAddress,
        side,
        outcome,
        price,
        quantity,
        limitPrice,
        maxSlippagePct,
        allowPartialFill,
      })
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Cursor pagination helpers for GET /orders/user/:address
// Cursor encodes the last seen { createdAt (ISO string), id } so the next
// page starts strictly after that row using the same (createdAt DESC, id DESC)
// ordering the query uses.
// ---------------------------------------------------------------------------

interface CursorPayload {
  createdAt: string;
  id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).createdAt !== "string" ||
      typeof (parsed as Record<string, unknown>).id !== "string"
    ) {
      throw new Error("invalid shape");
    }
    return parsed as CursorPayload;
  } catch {
    throw new ValidationError("cursor is invalid or corrupted");
  }
}

// ---------------------------------------------------------------------------
// Optional Redis cache layer for GET /trades
// Disabled by default; enable with TRADES_CACHE_ENABLED=true. Read failures
// fall back to Postgres so caching never affects availability of the route.
// Key convention follows docs/api-versioning.md: <resource>:<version>:<id>
// ---------------------------------------------------------------------------

function isTradesCacheEnabled(): boolean {
  return process.env.TRADES_CACHE_ENABLED === "true";
}

function getTradesCacheTtlSeconds(): number {
  const raw = Number(process.env.TRADES_CACHE_TTL);
  return Number.isInteger(raw) && raw > 0 ? raw : 15;
}

function buildTradesCacheKey(query: GetWalletTradesQuery): string {
  const { page = 1, limit = 20, marketId, from, to } = query;
  return redis.prefixed(
    `trades:v1:${page}:${limit}:${marketId ?? "*"}:${from ?? "*"}:${to ?? "*"}`
  );
}

// ---------------------------------------------------------------------------
// Route interfaces
// ---------------------------------------------------------------------------

export interface GetUserOrdersParams {
  address: string;
}

export interface GetUserOrdersQuery {
  status?: OrderStatus;
  cursor?: string;
  limit?: number;
}

export interface GetWalletTradesQuery {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
  marketId?: string;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface OrderResponse {
  id: string;
  marketId: string;
  userAddress: string;
  side: OrderSide;
  outcome: Outcome;
  price: string;
  quantity: number;
  filledQuantity: number;
  status: OrderStatus;
  createdAt: Date;
}

export interface OrderListResponse {
  orders: OrderResponse[];
  total: number;
  hasNext: boolean;
  page: number;
  limit: number;
}

export interface TradeEntry {
  id: string;
  marketId: string;
  outcome: Outcome;
  buyerAddress: string;
  sellerAddress: string;
  buyOrderId: string;
  sellOrderId: string;
  /** Exact decimal price string as stored (never a lossy `Number`). */
  price: string;
  quantity: number;
  timestamp: number;
  /** `timestamp` normalized to an ISO-8601 UTC string. */
  timestampIso: string;
  loggedAt: string;
}

export interface TradeListResponse {
  trades: TradeEntry[];
  total: number;
  hasNext: boolean;
  page: number;
  limit: number;
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
            marketId: {
              type: "string",
              description: "Filter trades by market identifier",
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { address } = request.params;
      const { page = 1, limit = 20, from, to, marketId } = request.query;

      if (!validateUserAddress(address)) {
        throw new ValidationError("Invalid Stellar address format");
      }

      const sanitizedAddress = sanitizeUserAddress(address);

      const where: Record<string, unknown> = {
        OR: [
          { buyerAddress: sanitizedAddress },
          { sellerAddress: sanitizedAddress },
        ],
      };

      if (marketId) {
        where.marketId = marketId;
      }

      if (from || to) {
        const createdAt: Record<string, Date> = {};
        if (from) createdAt.gte = new Date(from);
        if (to) createdAt.lte = new Date(to);
        where.createdAt = createdAt;
      }

      const cacheKey = isTradesCacheEnabled()
        ? buildTradesCacheKey({ page, limit, from, to, marketId })
        : null;

      if (cacheKey) {
        try {
          const cached = await redis.get(cacheKey);
          if (cached) {
            return reply.send(JSON.parse(cached));
          }
        } catch {
          // Cache read failures fall through to Postgres.
        }
      }

      const [trades, total] = await Promise.all([
        prisma.trade.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.trade.count({ where }),
      ]);

      const response: TradeListResponse = {
        trades: trades.map((trade) => ({
          id: trade.id,
          marketId: trade.marketId,
          outcome: trade.outcome as Outcome,
          buyerAddress: trade.buyerAddress,
          sellerAddress: trade.sellerAddress,
          buyOrderId: trade.buyOrderId,
          sellOrderId: trade.sellOrderId,
          price: trade.price.toString(),
          quantity: trade.quantity,
          timestamp: trade.createdAt.getTime(),
          timestampIso: trade.createdAt.toISOString(),
          loggedAt: trade.createdAt.toISOString(),
        })),
        total,
        hasNext: page * limit < total,
        page,
        limit,
      };

      if (cacheKey) {
        try {
          await redis.set(
            cacheKey,
            JSON.stringify(response),
            "EX",
            getTradesCacheTtlSeconds()
          );
        } catch {
          // Cache write failures are non-fatal.
        }
      }

      return reply.send(response);
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
              enum: ["OPEN", "PARTIALLY_FILLED", "FILLED", "CANCELLED"],
            },
            cursor: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { address } = request.params;
      const { status, cursor, limit = 20 } = request.query;

      if (!validateUserAddress(address)) {
        throw new ValidationError("Invalid Stellar address format");
      }

      const sanitizedAddress = sanitizeUserAddress(address);

      const where: Record<string, unknown> = { userAddress: sanitizedAddress };
      if (status) where.status = status;

      if (cursor) {
        const decoded = decodeCursor(cursor);
        where.OR = [
          { createdAt: { lt: new Date(decoded.createdAt) } },
          {
            createdAt: new Date(decoded.createdAt),
            id: { lt: decoded.id },
          },
        ];
      }

      const orders = await prisma.order.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });

      const hasNext = orders.length > limit;
      const page = hasNext ? orders.slice(0, limit) : orders;
      const last = page[page.length - 1];

      const response: OrderListResponse = {
        orders: page.map((order) => ({
          id: order.id,
          marketId: order.marketId,
          userAddress: order.userAddress,
          side: order.side as OrderSide,
          outcome: order.outcome as Outcome,
          price: order.price.toString(),
          quantity: order.quantity,
          filledQuantity: order.filledQuantity,
          status: order.status as OrderStatus,
          createdAt: order.createdAt,
        })),
        total: page.length,
        hasNext,
        page: 1,
        limit,
      };

      if (hasNext && last) {
        reply.header(
          "X-Next-Cursor",
          encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        );
      }

      return reply.send(response);
    }
  );

  fastify.post<{ Body: CreateOrderBody }>(
    "/orders",
    {
      onRequest: [writeLimiter],
      schema: {
        body: {
          type: "object",
          required: ["marketId", "userAddress", "side", "outcome", "price", "quantity"],
          properties: {
            marketId: { type: "string", minLength: 1 },
            userAddress: { type: "string" },
            side: { type: "string", enum: ["BUY", "SELL"] },
            outcome: { type: "string", enum: ["YES", "NO"] },
            price: { type: "number", minimum: 0, exclusiveMaximum: 1 },
            quantity: { type: "integer", minimum: 1 },
            limitPrice: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
            maxSlippagePct: { type: "number", minimum: 0, maximum: 100 },
            allowPartialFill: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const idempotencyKey = parseIdempotencyKey(request);

      const parsed = CreateOrderSchema.safeParse(request.body);
      if (!parsed.success) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const field = issue.path.join(".") || "body";
          if (!fieldErrors[field]) fieldErrors[field] = issue.message;
        }
        throw new ValidationError("Invalid order payload", fieldErrors);
      }

      const body = parsed.data;
      const requestHash = hashOrderRequest(body);

      if (idempotencyKey) {
        const requestHash = hashOrderRequest(body);
        const cacheKey = redis.prefixed(`idempotency:orders:${idempotencyKey}`);
        try {
          const cached = await redis.get(cacheKey);
          if (cached) {
            const entry = JSON.parse(cached) as {
              hash: string;
              response: unknown;
            };
            if (entry.hash !== requestHash) {
              throw new IdempotencyConflictError();
            }
            // Exact replay: same key, same payload — return the original body
            // with 200 and flag it as a replay.
            return reply
              .code(200)
              .header("Idempotent-Replayed", "true")
              .send(entry.response);
          }
        } catch (err) {
          if (err instanceof IdempotencyConflictError) throw err;
          // Cache read failures fall through to normal processing.
        }
      }

      const orderInput: OrderInput = {
        marketId: body.marketId,
        userAddress: sanitizeUserAddress(body.userAddress),
        side: body.side,
        outcome: body.outcome,
        price: body.price,
        quantity: body.quantity,
        limitPrice: body.limitPrice,
        maxSlippagePct: body.maxSlippagePct,
        allowPartialFill: body.allowPartialFill,
      };

      await assertValidOrder(orderInput);

      const result = await matchingService.placeOrder(
        orderInput,
        idempotencyKey
          ? { key: idempotencyKey, requestHash: hashOrderRequest(body) }
          : undefined
      );

      // The replay state is only known once the matching service has answered:
      // an exact replay returns the stored result instead of placing a new order.
      const replayed = result.replayed === true;

      const response: OrderResponse = {
        id: result.order.id,
        marketId: result.order.marketId,
        userAddress: result.order.userAddress,
        side: result.order.side as OrderSide,
        outcome: result.order.outcome as Outcome,
        price: result.order.price.toString(),
        quantity: result.order.quantity,
        filledQuantity: result.order.filledQuantity,
        status: result.order.status as OrderStatus,
        createdAt: result.order.createdAt,
      };

      if (idempotencyKey) {
        const cacheKey = redis.prefixed(`idempotency:orders:${idempotencyKey}`);
        try {
          await redis.set(
            cacheKey,
            JSON.stringify({ hash: hashOrderRequest(body), response }),
            "EX",
            86400
          );
        } catch {
          // Cache write failures are non-fatal.
        }
      }

      if (replayed) {
        return reply
          .code(200)
          .header("Idempotent-Replayed", "true")
          .send(response);
      }

      return reply.code(201).send(response);
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/orders/:id",
    {
      onRequest: [writeLimiter],
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
    async (request, reply) => {
      const { id } = request.params;

      const order = await prisma.order.findUnique({ where: { id } });
      if (!order) {
        throw new NotFoundError("Order not found");
      }

      if (order.status === "FILLED" || order.status === "CANCELLED") {
        throw new ValidationError(
          `Cannot cancel an order with status ${order.status}`
        );
      }

      const signature = request.headers["x-stellar-signature"];
      const signedMessage = request.headers["x-stellar-message"];
      if (typeof signature !== "string" || typeof signedMessage !== "string") {
        throw new ValidationError(
          "Missing Stellar signature headers for cancellation"
        );
      }

      const valid = verifyStellarCancellationSignature(
        order.userAddress,
        id,
        signature,
        signedMessage
      );
      if (!valid) {
        throw new ValidationError("Invalid Stellar signature for cancellation");
      }

      const cancelled = await matchingService.cancelOrder(id);

      await auditService.log({
        action: "ORDER_CANCELLED",
        actor: order.userAddress,
        target: id,
        metadata: { marketId: order.marketId },
      });

      return reply.send({
        id: cancelled.id,
        status: cancelled.status,
      });
    }
  );
}
