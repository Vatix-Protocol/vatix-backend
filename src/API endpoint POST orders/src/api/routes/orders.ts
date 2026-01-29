import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { OrderValidator } from "../services/orderValidator";
import { MatchingEngine } from "../services/matchingEngine";
import { SigningService } from "../services/signingService";
import { OrderBookCache } from "../services/orderBookCache";

// Types
interface OrderRequest {
  marketId: string;
  side: "BUY" | "SELL";
  outcome: string;
  price: number;
  quantity: number;
}

interface AuthRequest extends FastifyRequest {
  userAddress?: string;
}

interface OrderReceipt {
  orderId: string;
  marketId: string;
  side: string;
  outcome: string;
  price: number;
  quantity: number;
  filledQuantity: number;
  status: string;
  trades: Trade[];
  timestamp: Date;
  signature: string;
}

interface Trade {
  tradeId: string;
  price: number;
  quantity: number;
  makerOrderId: string;
  takerOrderId: string;
  timestamp: Date;
}

interface Position {
  userId: string;
  marketId: string;
  outcome: string;
  quantity: number;
  averagePrice: number;
}

// Constants
const ORDER_STATUS = {
  OPEN: "OPEN",
  PARTIALLY_FILLED: "PARTIALLY_FILLED",
  FILLED: "FILLED",
  CANCELLED: "CANCELLED",
} as const;

// Schema for validation
const orderSchema = {
  body: {
    type: "object",
    required: ["marketId", "side", "outcome", "price", "quantity"],
    properties: {
      marketId: { type: "string", minLength: 1 },
      side: { type: "string", enum: ["BUY", "SELL"] },
      outcome: { type: "string", minLength: 1 },
      price: { type: "number", minimum: 0, maximum: 1 },
      quantity: { type: "number", minimum: 0, exclusiveMinimum: true },
    },
  },
};

export default async function ordersRoute(fastify: FastifyInstance) {
  // Initialize services
  const prisma = new PrismaClient();
  const redis = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    password: process.env.REDIS_PASSWORD,
    retryStrategy: (times: number) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
  });

  const orderValidator = new OrderValidator(prisma);
  const matchingEngine = new MatchingEngine();
  const signingService = new SigningService(
    process.env.SIGNING_PRIVATE_KEY || "",
  );
  const orderBookCache = new OrderBookCache(redis);

  // Basic authentication hook
  fastify.decorateRequest("userAddress", "");

  fastify.addHook(
    "preHandler",
    async (request: AuthRequest, reply: FastifyReply) => {
      try {
        // Extract user address from Authorization header
        // Format: Bearer <address> or just <address>
        const authHeader = request.headers.authorization;

        if (!authHeader) {
          return reply.code(401).send({
            error: "Unauthorized",
            message: "Missing Authorization header",
          });
        }

        const address = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7)
          : authHeader;

        // Basic validation of Ethereum address format
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
          return reply.code(401).send({
            error: "Unauthorized",
            message: "Invalid address format",
          });
        }

        request.userAddress = address;
      } catch (error) {
        return reply.code(401).send({
          error: "Unauthorized",
          message: "Authentication failed",
        });
      }
    },
  );

  // POST /orders endpoint
  fastify.post<{ Body: OrderRequest }>(
    "/orders",
    { schema: orderSchema },
    async (request: AuthRequest, reply: FastifyReply) => {
      const startTime = Date.now();
      let orderId: string | null = null;

      try {
        const { marketId, side, outcome, price, quantity } = request.body;
        const userAddress = request.userAddress!;

        fastify.log.info({
          msg: "Processing order submission",
          userAddress,
          marketId,
          side,
          outcome,
          price,
          quantity,
        });

        // Use distributed lock to handle concurrent orders safely
        const lockKey = `order:lock:${userAddress}:${marketId}`;
        const lockValue = `${Date.now()}-${Math.random()}`;
        const lockAcquired = await redis.set(
          lockKey,
          lockValue,
          "PX",
          5000,
          "NX",
        );

        if (!lockAcquired) {
          return reply.code(429).send({
            error: "TooManyRequests",
            message: "Please wait before submitting another order",
          });
        }

        try {
          // Execute all operations in a transaction
          const result = await prisma.$transaction(
            async (tx) => {
              // 1. Validate order
              const validation = await orderValidator.validate(
                {
                  marketId,
                  side,
                  outcome,
                  price,
                  quantity,
                  userAddress,
                },
                tx,
              );

              if (!validation.valid) {
                throw new ValidationError(validation.errors.join(", "));
              }

              // 2. Create order in database
              const order = await tx.order.create({
                data: {
                  id: generateOrderId(),
                  marketId,
                  userId: userAddress,
                  side,
                  outcome,
                  price,
                  quantity,
                  filledQuantity: 0,
                  status: ORDER_STATUS.OPEN,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              });

              orderId = order.id;

              // 3. Add order to Redis order book cache (optimistic)
              await orderBookCache.addOrder({
                orderId: order.id,
                marketId,
                side,
                outcome,
                price,
                quantity,
                userId: userAddress,
                timestamp: order.createdAt,
              });

              // 4. Attempt to match order
              const matchResult = await matchingEngine.matchOrder(
                {
                  orderId: order.id,
                  marketId,
                  side,
                  outcome,
                  price,
                  quantity,
                  userId: userAddress,
                },
                tx,
                orderBookCache,
              );

              const trades: Trade[] = [];
              let totalFilledQuantity = 0;

              // 5. Process matches and create trades
              for (const match of matchResult.matches) {
                const trade = await tx.trade.create({
                  data: {
                    id: generateTradeId(),
                    marketId,
                    outcome,
                    price: match.price,
                    quantity: match.quantity,
                    makerOrderId: match.makerOrderId,
                    takerOrderId: order.id,
                    makerId: match.makerId,
                    takerId: userAddress,
                    createdAt: new Date(),
                  },
                });

                trades.push({
                  tradeId: trade.id,
                  price: trade.price,
                  quantity: trade.quantity,
                  makerOrderId: trade.makerOrderId,
                  takerOrderId: trade.takerOrderId,
                  timestamp: trade.createdAt,
                });

                totalFilledQuantity += match.quantity;

                // Update maker order
                await tx.order.update({
                  where: { id: match.makerOrderId },
                  data: {
                    filledQuantity: {
                      increment: match.quantity,
                    },
                    status:
                      match.makerRemainingQuantity === 0
                        ? ORDER_STATUS.FILLED
                        : ORDER_STATUS.PARTIALLY_FILLED,
                    updatedAt: new Date(),
                  },
                });

                // Update maker position
                await updatePosition(
                  tx,
                  match.makerId,
                  marketId,
                  outcome,
                  match.quantity,
                  match.price,
                  match.makerSide === "BUY",
                );

                // Update order book cache for maker order
                if (match.makerRemainingQuantity === 0) {
                  await orderBookCache.removeOrder(
                    match.makerOrderId,
                    marketId,
                    match.makerSide,
                    outcome,
                  );
                } else {
                  await orderBookCache.updateOrderQuantity(
                    match.makerOrderId,
                    marketId,
                    match.makerSide,
                    outcome,
                    match.makerRemainingQuantity,
                  );
                }
              }

              // 6. Update taker order status
              const remainingQuantity = quantity - totalFilledQuantity;
              const orderStatus =
                remainingQuantity === 0
                  ? ORDER_STATUS.FILLED
                  : totalFilledQuantity > 0
                    ? ORDER_STATUS.PARTIALLY_FILLED
                    : ORDER_STATUS.OPEN;

              const updatedOrder = await tx.order.update({
                where: { id: order.id },
                data: {
                  filledQuantity: totalFilledQuantity,
                  status: orderStatus,
                  updatedAt: new Date(),
                },
              });

              // 7. Update taker position
              if (totalFilledQuantity > 0) {
                const avgTradePrice =
                  trades.reduce((sum, t) => sum + t.price * t.quantity, 0) /
                  totalFilledQuantity;

                await updatePosition(
                  tx,
                  userAddress,
                  marketId,
                  outcome,
                  totalFilledQuantity,
                  avgTradePrice,
                  side === "BUY",
                );
              }

              // 8. If order not fully filled, keep it in order book
              if (remainingQuantity > 0) {
                await orderBookCache.updateOrderQuantity(
                  order.id,
                  marketId,
                  side,
                  outcome,
                  remainingQuantity,
                );
              } else {
                // Remove from order book if fully filled
                await orderBookCache.removeOrder(
                  order.id,
                  marketId,
                  side,
                  outcome,
                );
              }

              return {
                order: updatedOrder,
                trades,
                totalFilledQuantity,
              };
            },
            {
              maxWait: 10000, // 10 seconds
              timeout: 30000, // 30 seconds
              isolationLevel: "Serializable",
            },
          );

          // 9. Generate signed receipt
          const receipt: OrderReceipt = {
            orderId: result.order.id,
            marketId: result.order.marketId,
            side: result.order.side,
            outcome: result.order.outcome,
            price: result.order.price,
            quantity: result.order.quantity,
            filledQuantity: result.totalFilledQuantity,
            status: result.order.status,
            trades: result.trades,
            timestamp: result.order.createdAt,
            signature: "",
          };

          receipt.signature = await signingService.signReceipt(receipt);

          const duration = Date.now() - startTime;
          fastify.log.info({
            msg: "Order processed successfully",
            orderId: receipt.orderId,
            status: receipt.status,
            filledQuantity: receipt.filledQuantity,
            tradesCount: receipt.trades.length,
            duration,
          });

          return reply.code(201).send(receipt);
        } finally {
          // Release lock
          const lockScript = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
              return redis.call("del", KEYS[1])
            else
              return 0
            end
          `;
          await redis.eval(lockScript, 1, lockKey, lockValue);
        }
      } catch (error) {
        fastify.log.error({
          msg: "Order processing failed",
          error: error instanceof Error ? error.message : "Unknown error",
          orderId,
          userAddress: request.userAddress,
        });

        if (error instanceof ValidationError) {
          return reply.code(400).send({
            error: "ValidationError",
            message: error.message,
            orderId,
          });
        }

        if (error instanceof InsufficientBalanceError) {
          return reply.code(400).send({
            error: "InsufficientBalance",
            message: error.message,
            orderId,
          });
        }

        return reply.code(500).send({
          error: "InternalServerError",
          message: "Failed to process order. Please try again.",
          orderId,
        });
      }
    },
  );

  // Health check endpoint
  fastify.get("/orders/health", async (request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      await redis.ping();
      return reply.send({ status: "healthy", timestamp: new Date() });
    } catch (error) {
      return reply.code(503).send({
        status: "unhealthy",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Cleanup on close
  fastify.addHook("onClose", async () => {
    await prisma.$disconnect();
    await redis.quit();
  });
}

// Helper functions
async function updatePosition(
  tx: any,
  userId: string,
  marketId: string,
  outcome: string,
  quantity: number,
  price: number,
  isBuy: boolean,
): Promise<void> {
  const existingPosition = await tx.position.findUnique({
    where: {
      userId_marketId_outcome: {
        userId,
        marketId,
        outcome,
      },
    },
  });

  if (existingPosition) {
    const currentQuantity = existingPosition.quantity;
    const currentValue = currentQuantity * existingPosition.averagePrice;
    const newQuantity = isBuy
      ? currentQuantity + quantity
      : currentQuantity - quantity;
    const newValue = isBuy
      ? currentValue + quantity * price
      : currentValue - quantity * price;
    const newAveragePrice = newQuantity !== 0 ? newValue / newQuantity : 0;

    await tx.position.update({
      where: {
        userId_marketId_outcome: {
          userId,
          marketId,
          outcome,
        },
      },
      data: {
        quantity: newQuantity,
        averagePrice: newAveragePrice,
        updatedAt: new Date(),
      },
    });
  } else {
    await tx.position.create({
      data: {
        userId,
        marketId,
        outcome,
        quantity: isBuy ? quantity : -quantity,
        averagePrice: price,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }
}

function generateOrderId(): string {
  return `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function generateTradeId(): string {
  return `TRD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Custom error classes
class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

class InsufficientBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientBalanceError";
  }
}
