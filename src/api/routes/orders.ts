import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { getPrismaClient } from "../../services/prisma.js";
import { ValidationError } from "../middleware/errors.js";
import type { OrderSide, Outcome, OrderStatus } from "../../types/index.js";
import { auditService } from "../../services/audit.js";
import {
  validateUserAddress,
  assertValidOrder,
  STELLAR_PUBLIC_KEY_REGEX,
  type OrderInput,
} from "../../matching/validation.js";
import { heavyReadLimiter, writeLimiter } from "../middleware/rateLimiter.js";

// ---------------------------------------------------------------------------
// Zod schema for POST /orders body
// ---------------------------------------------------------------------------

const CreateOrderSchema = z.object({
  marketId: z.string().min(1, "marketId is required"),
  userAddress: z
    .string()
    .regex(
      STELLAR_PUBLIC_KEY_REGEX,
      "userAddress must be a valid Stellar public key"
    ),
  side: z.enum(["BUY", "SELL"]),
  outcome: z.enum(["YES", "NO"]),
  price: z
    .number()
    .gt(0, "price must be greater than 0")
    .lt(1, "price must be less than 1"),
  quantity: z
    .number()
    .int("quantity must be an integer")
    .min(1, "quantity must be at least 1"),
});

type CreateOrderBody = z.infer<typeof CreateOrderSchema>;

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
// Route interfaces
// ---------------------------------------------------------------------------

interface GetUserOrdersParams {
  address: string;
}

interface GetUserOrdersQuery {
  status?: OrderStatus;
  cursor?: string;
  limit?: number;
}

interface GetWalletTradesQuery {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

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
          throw new ValidationError(
            "from must be a valid UTC ISO-8601 timestamp"
          );
        }
      }

      if (to !== undefined) {
        toMs = Date.parse(to);
        if (Number.isNaN(toMs)) {
          throw new ValidationError(
            "to must be a valid UTC ISO-8601 timestamp"
          );
        }
      }

      if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
        throw new ValidationError(
          "Invalid date range: from must be earlier than or equal to to"
        );
      }

      const { trades, total, hasNext } =
        await auditService.getWalletTradeHistory(
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

  // GET /orders/user/:address — cursor-paginated list of orders for a wallet.
  // Cursor encodes the last item's (createdAt, id) and is opaque to clients.
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
            cursor: { type: "string" },
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
              nextCursor: { type: ["string", "null"] },
              hasNext: { type: "boolean" },
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
      }>
    ) => {
      const { address } = request.params;
      const { status, cursor, limit = 20 } = request.query;

      const addressError = validateUserAddress(address);
      if (addressError) {
        throw new ValidationError(addressError);
      }

      // Decode cursor to a position anchor when provided
      let cursorPayload: CursorPayload | undefined;
      if (cursor) {
        cursorPayload = decodeCursor(cursor);
      }

      const baseWhere = {
        userAddress: address,
        ...(status ? { status } : {}),
      };

      // Build cursor condition: rows that come strictly after the cursor in
      // (createdAt DESC, id DESC) order.
      const cursorWhere = cursorPayload
        ? {
            OR: [
              { createdAt: { lt: new Date(cursorPayload.createdAt) } },
              {
                createdAt: { equals: new Date(cursorPayload.createdAt) },
                id: { lt: cursorPayload.id },
              },
            ],
          }
        : {};

      const whereClause = cursorPayload
        ? { AND: [baseWhere, cursorWhere] }
        : baseWhere;

      // Fetch one extra row to detect whether another page exists
      const orders = await prisma.order.findMany({
        where: whereClause,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });

      const hasNext = orders.length > limit;
      const page = orders.slice(0, limit);

      let nextCursor: string | null = null;
      if (hasNext) {
        const last = page[page.length - 1];
        nextCursor = encodeCursor({
          createdAt: last.createdAt.toISOString(),
          id: last.id,
        });
      }

      return {
        orders: page,
        nextCursor,
        hasNext,
        limit,
      };
    }
  );

  // POST /orders — create a new order.
  // Zod validates the request body shape and types; assertValidOrder does
  // domain validation (address format, market state).
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
      // Zod parse: produces a typed, validated body or throws with field-level errors
      const parseResult = CreateOrderSchema.safeParse(request.body);
      if (!parseResult.success) {
        const fields: Record<string, string> = {};
        for (const issue of parseResult.error.issues) {
          const field = issue.path.join(".") || "body";
          fields[field] = issue.message;
        }
        throw new ValidationError(parseResult.error.issues[0].message, fields);
      }

      const { marketId, userAddress, side, outcome, price, quantity } =
        parseResult.data;

      const orderInput: OrderInput = {
        marketId,
        userAddress,
        side: side as OrderSide,
        outcome: outcome as Outcome,
        price,
        quantity,
      };

      // Domain validation: address format, market existence and state
      await assertValidOrder(orderInput);

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
