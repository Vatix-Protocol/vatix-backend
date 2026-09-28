import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../../src/services/prisma.js";
import type { Prisma, OrderStatus } from "../../../src/generated/prisma/client";
import { STELLAR_PUBLIC_KEY_REGEX } from "../../../src/matching/validation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Authenticated principal attached to the request by the session/JWT layer.
 * `id` is the trader's Stellar public key and is the order owner recorded on
 * `Order.userAddress`; `role` drives the deny-by-default authz below.
 */
interface Principal {
  id: string;
  role: string;
  sub?: string;
}

type AuthenticatedRequest = FastifyRequest & { user?: Principal };

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
  outcome: "YES" | "NO";
  price: string;
  quantity: number;
  idempotencyKey?: string;
}

interface CancelOrderParams {
  id: string;
}

const ORDER_STATUSES = [
  "OPEN",
  "FILLED",
  "CANCELLED",
  "PARTIALLY_FILLED",
] as const;
const ORDER_SIDES = ["BUY", "SELL"] as const;
const OUTCOMES = ["YES", "NO"] as const;

/** Roles permitted to mutate orders. Anything else fails closed with 403. */
const WRITE_ROLES = new Set(["TRADER", "ADMIN"]);

/** Maximum contracts per order. Bounds the blast radius of a fat-fingered or
 *  hostile payload; the `Int` column could otherwise accept ~2^31. */
const MAX_ORDER_QUANTITY = 1_000_000;

/** Upper bound on the idempotency key, matching the `VarChar(64)` column. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 64;

/** Stable error codes for the orders API surface. */
const ERR = {
  UNAUTHORIZED: "ORDERS_UNAUTHORIZED",
  FORBIDDEN: "ORDERS_FORBIDDEN",
  NOT_FOUND: "ORDERS_NOT_FOUND",
  MARKET_NOT_FOUND: "ORDERS_MARKET_NOT_FOUND",
  VALIDATION: "ORDERS_VALIDATION_FAILED",
  CONFLICT: "ORDERS_IDEMPOTENCY_CONFLICT",
  RATE_LIMITED: "ORDERS_RATE_LIMITED",
  UNAVAILABLE: "ORDERS_DEPENDENCY_UNAVAILABLE",
  INTERNAL: "ORDERS_INTERNAL_ERROR",
} as const;

type PrismaClient = ReturnType<typeof getPrismaClient>;

function correlationId(request: FastifyRequest): string {
  const header = request.headers["x-correlation-id"];
  if (
    typeof header === "string" &&
    header.length > 0 &&
    header.length <= 128 &&
    // Reject control characters so a hostile caller cannot forge log lines or
    // response headers through the echoed correlation id.
    !/[\u0000-\u001f\u007f]/.test(header)
  ) {
    return header;
  }
  return request.id;
}

function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  correlation: string
) {
  return reply.status(status).send({
    error: { code, message, correlationId: correlation },
  });
}

// ---------------------------------------------------------------------------
// Authz (deny-by-default)
// ---------------------------------------------------------------------------

type AuthzResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: number; code: string; message: string };

/**
 * Establishes an authenticated principal. Fails closed: a missing session, a
 * principal without an id, or an id that is not a Stellar public key is a 401
 * — we never fall back to an anonymous actor. The address check is the
 * testnet/mainnet drift guard: an order is only ever written against a
 * well-formed Stellar account.
 */
function authenticate(request: FastifyRequest): AuthzResult {
  const user = (request as AuthenticatedRequest).user;
  if (!user || typeof user.id !== "string" || user.id.length === 0) {
    return {
      ok: false,
      status: 401,
      code: ERR.UNAUTHORIZED,
      message: "Authentication required",
    };
  }
  if (!STELLAR_PUBLIC_KEY_REGEX.test(user.id)) {
    return {
      ok: false,
      status: 401,
      code: ERR.UNAUTHORIZED,
      message: "Principal is not a valid Stellar account",
    };
  }
  return { ok: true, principal: user };
}

/** Privileged surfaces require an allowed role; wrong role fails closed. */
function requireWriteRole(principal: Principal): AuthzResult {
  if (!WRITE_ROLES.has(principal.role)) {
    return {
      ok: false,
      status: 403,
      code: ERR.FORBIDDEN,
      message: "Insufficient role for order writes",
    };
  }
  return { ok: true, principal };
}

function isAdmin(principal: Principal): boolean {
  return principal.role === "ADMIN";
}

/**
 * Non-admin callers only ever see their own orders. Applied to the query
 * predicate rather than filtered after the fact so pagination totals cannot
 * leak another trader's book.
 */
function ownershipScope(principal: Principal): Prisma.OrderWhereInput {
  return isAdmin(principal) ? {} : { userAddress: principal.id };
}

// ---------------------------------------------------------------------------
// Fail-closed writes
// ---------------------------------------------------------------------------

/**
 * Writes must not proceed when the orders store is unavailable. A read probe
 * is enough here: the subsequent query in the same handler would fail too,
 * and answering 503 up front keeps a money path from being entered at all.
 */
async function dependencyHealthy(prisma: PrismaClient): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Soft-deleted markets (#1126 — docs/SOFT_DELETED_MARKETS.md)
// ---------------------------------------------------------------------------

/**
 * Logic-level soft-delete rejection. `deletedAt !== null` deliberately treats
 * `undefined` as deleted too, so a projection that ever omits the column
 * fails closed instead of letting orders through.
 */
async function assertMarketIsTradable(
  prisma: PrismaClient,
  marketId: string
): Promise<boolean> {
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  return Boolean(market) && market?.deletedAt === null;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Two replays of the same idempotency key are only the same request when the
 * payload matches. Comparing the persisted order against the incoming body
 * is what lets a client safely retry after a timeout: an identical retry gets
 * the original order back, a *different* payload under the same key is a
 * client bug and must never silently reuse the first order.
 */
function isSameOrderPayload(
  order: {
    marketId: string;
    side: string;
    outcome: string;
    price: unknown;
    quantity: number;
  },
  body: CreateOrderBody
): boolean {
  return (
    order.marketId === body.marketId &&
    order.side === body.side &&
    order.outcome === body.outcome &&
    order.quantity === body.quantity &&
    Number(order.price) === Number(body.price)
  );
}

type ReplayResult =
  | { kind: "replay"; order: unknown }
  | { kind: "conflict" }
  | { kind: "absent" };

/**
 * Resolves an idempotency key to an existing order.
 *
 * A key owned by a *different* principal is reported as a conflict rather
 * than replayed: otherwise a caller could probe another trader's keys and
 * learn that they exist.
 */
async function resolveIdempotentReplay(
  prisma: PrismaClient,
  key: string | undefined,
  body: CreateOrderBody,
  principal: Principal
): Promise<ReplayResult> {
  if (!key) {
    return { kind: "absent" };
  }
  const existing = await prisma.order.findUnique({
    where: { idempotencyKey: key },
  });
  if (!existing) {
    return { kind: "absent" };
  }
  if (existing.userAddress !== principal.id) {
    return { kind: "conflict" };
  }
  return isSameOrderPayload(existing, body)
    ? { kind: "replay", order: existing }
    : { kind: "conflict" };
}

// ---------------------------------------------------------------------------
// Rate limiting (RATE_LIMIT_POLICY.md)
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;

/** External read entrypoints. */
const READ_RATE_LIMIT_MAX_REQUESTS = 120;

/** Money-path mutations get a tighter budget than reads. */
const WRITE_RATE_LIMIT_MAX_REQUESTS = 30;

/** Sweep cadence, counted in requests (no timer to schedule or tear down). */
const RATE_LIMIT_SWEEP_EVERY_N_REQUESTS = 1_000;

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();
let requestsSinceSweep = 0;

/**
 * Every distinct client identity (and every spoofable `X-Forwarded-For` value
 * behind a misconfigured proxy) would otherwise add a bucket that is only
 * ever overwritten, never removed. Evict expired entries opportunistically
 * off request volume so the map stays bounded.
 */
export function sweepExpiredRateLimitEntries(now: number = Date.now()): void {
  for (const [key, bucket] of rateLimitBuckets) {
    if (now >= bucket.resetAt) {
      rateLimitBuckets.delete(key);
    }
  }
}

/** Clear all counters — for use in tests only. */
export function resetOrderRateLimits(): void {
  rateLimitBuckets.clear();
  requestsSinceSweep = 0;
}

function maybeSweepRateLimitEntries(now: number): void {
  requestsSinceSweep += 1;
  if (requestsSinceSweep >= RATE_LIMIT_SWEEP_EVERY_N_REQUESTS) {
    requestsSinceSweep = 0;
    sweepExpiredRateLimitEntries(now);
  }
}

/**
 * The client key prefers the authenticated subject so an untrusted client
 * cannot bypass the policy by rotating source addresses. It never contains
 * credentials or tokens.
 */
function clientIdentity(request: FastifyRequest): string {
  const user = (request as AuthenticatedRequest).user;
  if (user && typeof user.id === "string" && user.id.length > 0) {
    return `user:${user.id}`;
  }
  const subject = user?.sub;
  if (typeof subject === "string" && subject.length > 0) {
    return `sub:${subject}`;
  }
  return `ip:${request.ip}`;
}

function enforceRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  correlation: string,
  maxRequests: number
): boolean {
  const now = Date.now();
  maybeSweepRateLimitEntries(now);
  const key = clientIdentity(request);
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return true;
  }

  if (bucket.count >= maxRequests) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    reply
      .status(429)
      .header("Retry-After", String(retryAfter))
      .send({
        error: {
          code: ERR.RATE_LIMITED,
          message: "Too many requests",
          correlationId: correlation,
          retryAfter,
        },
      });
    return false;
  }

  bucket.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function ordersRoutes(fastify: FastifyInstance) {
  const prisma = getPrismaClient();

  // Normalise every framework-level rejection into the same envelope the
  // handlers use. Without this, a payload rejected by the JSON schema (bad
  // enum, unknown field, oversized value) answers with Fastify's default
  // `{ statusCode, error, message }` shape while a handler-rejected payload
  // answers `{ error: { code, ... } }` — two error contracts for one API,
  // and the default shape leaks schema internals to the caller.
  fastify.setErrorHandler((error: unknown, request, reply) => {
    const correlation = correlationId(request);
    const frameworkError = error as {
      statusCode?: number;
      validation?: unknown;
      message?: string;
    };

    if (
      frameworkError.statusCode === 400 ||
      frameworkError.validation !== undefined
    ) {
      return fail(
        reply,
        400,
        ERR.VALIDATION,
        "Request payload failed schema validation",
        correlation
      );
    }

    if (frameworkError.statusCode === 413) {
      return fail(
        reply,
        413,
        ERR.VALIDATION,
        "Request payload too large",
        correlation
      );
    }

    if (frameworkError.statusCode === 429) {
      return fail(
        reply,
        429,
        ERR.RATE_LIMITED,
        "Too many requests",
        correlation
      );
    }

    // Never surface the driver message: it can embed connection strings.
    request.log?.error?.(
      { correlationId: correlation, err: frameworkError.message },
      "Unhandled orders route error"
    );
    return fail(reply, 500, ERR.INTERNAL, "Internal server error", correlation);
  });

  fastify.get<{ Querystring: GetOrdersQuery }>(
    "/orders",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: [...ORDER_STATUSES] },
            page: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: GetOrdersQuery }>, reply) => {
      const correlation = correlationId(request);

      if (
        !enforceRateLimit(
          request,
          reply,
          correlation,
          READ_RATE_LIMIT_MAX_REQUESTS
        )
      ) {
        return;
      }

      const auth = authenticate(request);
      if (!auth.ok) {
        return fail(reply, auth.status, auth.code, auth.message, correlation);
      }

      const { status, page = 1, limit = 20 } = request.query;
      // Ownership scope is part of the predicate, not a post-filter: an
      // unauthenticated or non-owner caller can never page into another
      // trader's orders, and `total` cannot leak their count.
      const where: Prisma.OrderWhereInput = {
        ...ownershipScope(auth.principal),
        ...(status ? { status: status as OrderStatus } : {}),
      };
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
        return fail(
          reply,
          503,
          ERR.UNAVAILABLE,
          "Orders store unavailable",
          correlation
        );
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
      if (
        !enforceRateLimit(
          request,
          reply,
          correlation,
          READ_RATE_LIMIT_MAX_REQUESTS
        )
      ) {
        return;
      }

      const auth = authenticate(request);
      if (!auth.ok) {
        return fail(reply, auth.status, auth.code, auth.message, correlation);
      }

      const { id } = request.params;

      try {
        const order = await prisma.order.findUnique({ where: { id } });
        // Owners see their own orders; admins see any. A caller that is
        // neither gets the same 404 as a missing order so the endpoint cannot
        // be used to probe which order ids exist.
        if (!order) {
          return fail(
            reply,
            404,
            ERR.NOT_FOUND,
            "Order not found",
            correlation
          );
        }
        if (
          !isAdmin(auth.principal) &&
          order.userAddress !== auth.principal.id
        ) {
          return fail(
            reply,
            404,
            ERR.NOT_FOUND,
            "Order not found",
            correlation
          );
        }

        reply.status(200).send({ order, correlationId: correlation });
      } catch {
        return fail(
          reply,
          503,
          ERR.UNAVAILABLE,
          "Orders store unavailable",
          correlation
        );
      }
    }
  );

  fastify.post<{ Body: CreateOrderBody }>(
    "/orders",
    {
      schema: {
        body: {
          type: "object",
          required: ["marketId", "side", "outcome", "price", "quantity"],
          additionalProperties: false,
          properties: {
            marketId: { type: "string", minLength: 1, maxLength: 128 },
            side: { type: "string", enum: [...ORDER_SIDES] },
            outcome: { type: "string", enum: [...OUTCOMES] },
            // Decimal-as-string keeps the value out of binary floating point;
            // the 0 < price < 1 and tick-size checks run in the handler.
            price: { type: "string", pattern: "^0\\.[0-9]{1,8}$" },
            quantity: {
              type: "integer",
              minimum: 1,
              maximum: MAX_ORDER_QUANTITY,
            },
            idempotencyKey: {
              type: "string",
              minLength: 1,
              maxLength: MAX_IDEMPOTENCY_KEY_LENGTH,
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateOrderBody }>, reply) => {
      const correlation = correlationId(request);

      // Money path: authorize *before* touching the store so a denied caller
      // cannot probe availability, and rate-limit the mutation itself.
      if (
        !enforceRateLimit(
          request,
          reply,
          correlation,
          WRITE_RATE_LIMIT_MAX_REQUESTS
        )
      ) {
        return;
      }

      const auth = authenticate(request);
      if (!auth.ok) {
        return fail(reply, auth.status, auth.code, auth.message, correlation);
      }
      const roleCheck = requireWriteRole(auth.principal);
      if (!roleCheck.ok) {
        return fail(
          reply,
          roleCheck.status,
          roleCheck.code,
          roleCheck.message,
          correlation
        );
      }

      const body = request.body;
      const price = Number(body.price);
      if (!(price > 0) || price >= 1) {
        return fail(
          reply,
          400,
          ERR.VALIDATION,
          "price must be greater than 0 and less than 1",
          correlation
        );
      }

      if (!(await dependencyHealthy(prisma))) {
        return fail(
          reply,
          503,
          ERR.UNAVAILABLE,
          "Orders store unavailable",
          correlation
        );
      }

      try {
        // Idempotency first: a replay never re-enters the market guard and
        // never writes, so it stays a cheap 200 even if the market has since
        // been soft-deleted (#1126).
        const replay = await resolveIdempotentReplay(
          prisma,
          body.idempotencyKey,
          body,
          auth.principal
        );
        if (replay.kind === "replay") {
          return reply
            .status(200)
            .send({ order: replay.order, correlationId: correlation });
        }
        if (replay.kind === "conflict") {
          return fail(
            reply,
            409,
            ERR.CONFLICT,
            "Idempotency key was already used with a different payload",
            correlation
          );
        }

        // Fail closed on soft-deleted markets: a retired market must be
        // unusable by every write path (docs/SOFT_DELETED_MARKETS.md).
        if (!(await assertMarketIsTradable(prisma, body.marketId))) {
          return fail(
            reply,
            404,
            ERR.MARKET_NOT_FOUND,
            "Market not found",
            correlation
          );
        }

        const order = await prisma.order.create({
          data: {
            marketId: body.marketId,
            side: body.side,
            outcome: body.outcome,
            price,
            quantity: body.quantity,
            status: "OPEN",
            userAddress: auth.principal.id,
            idempotencyKey: body.idempotencyKey ?? null,
          },
        });

        reply.status(201).send({ order, correlationId: correlation });
      } catch (err: unknown) {
        // Unique violation on idempotencyKey => a concurrent duplicate won the
        // race. Re-read and apply the same replay/conflict rules rather than
        // surfacing a 500 for what is a normal retry.
        if ((err as { code?: string } | null)?.code === "P2002") {
          const replay = await resolveIdempotentReplay(
            prisma,
            body.idempotencyKey,
            body,
            auth.principal
          );
          if (replay.kind === "replay") {
            return reply
              .status(200)
              .send({ order: replay.order, correlationId: correlation });
          }
          return fail(
            reply,
            409,
            ERR.CONFLICT,
            "Idempotency key was already used with a different payload",
            correlation
          );
        }
        return fail(
          reply,
          503,
          ERR.UNAVAILABLE,
          "Orders store unavailable",
          correlation
        );
      }
    }
  );

  fastify.post<{ Params: CancelOrderParams }>(
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
      },
    },
    async (request: FastifyRequest<{ Params: CancelOrderParams }>, reply) => {
      const correlation = correlationId(request);

      if (
        !enforceRateLimit(
          request,
          reply,
          correlation,
          WRITE_RATE_LIMIT_MAX_REQUESTS
        )
      ) {
        return;
      }

      const auth = authenticate(request);
      if (!auth.ok) {
        return fail(reply, auth.status, auth.code, auth.message, correlation);
      }
      const roleCheck = requireWriteRole(auth.principal);
      if (!roleCheck.ok) {
        return fail(
          reply,
          roleCheck.status,
          roleCheck.code,
          roleCheck.message,
          correlation
        );
      }

      if (!(await dependencyHealthy(prisma))) {
        return fail(
          reply,
          503,
          ERR.UNAVAILABLE,
          "Orders store unavailable",
          correlation
        );
      }

      const { id } = request.params;

      try {
        const order = await prisma.order.findUnique({ where: { id } });
        if (!order) {
          return fail(
            reply,
            404,
            ERR.NOT_FOUND,
            "Order not found",
            correlation
          );
        }

        // Ownership check: only the owner or an admin may cancel.
        if (
          !isAdmin(auth.principal) &&
          order.userAddress !== auth.principal.id
        ) {
          return fail(
            reply,
            403,
            ERR.FORBIDDEN,
            "Not authorized to cancel this order",
            correlation
          );
        }

        // Cancellation is naturally idempotent: replaying it returns the same
        // terminal state rather than failing, so a client that retries after
        // a timeout converges.
        if (order.status === "CANCELLED") {
          return reply.status(200).send({ order, correlationId: correlation });
        }
        if (order.status === "FILLED") {
          return fail(
            reply,
            409,
            ERR.CONFLICT,
            "Filled orders cannot be cancelled",
            correlation
          );
        }

        const updated = await prisma.order.update({
          where: { id },
          data: { status: "CANCELLED", version: { increment: 1 } },
        });

        reply.status(200).send({ order: updated, correlationId: correlation });
      } catch {
        return fail(
          reply,
          503,
          ERR.UNAVAILABLE,
          "Orders store unavailable",
          correlation
        );
      }
    }
  );
}
