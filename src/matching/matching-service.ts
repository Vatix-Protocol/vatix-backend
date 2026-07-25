import { randomUUID } from "crypto";
import type { Outcome } from "../types/index.js";
import type { OrderInput } from "./validation.js";
import { OrderBook } from "./orderbook.js";
import {
  matchOrder,
  outcomeToNumber,
  type MatchingOrder,
  type Trade,
} from "./engine.js";
import { Mutex } from "./mutex.js";
import { auditService } from "../services/audit.js";
import { settlementQueue } from "../services/settlement-queue.js";
import { redis } from "../services/redis.js";
import { getPrismaClient } from "../services/prisma.js";
import { ValidationError } from "../api/middleware/errors.js";

export interface PlaceOrderResult {
  order: any;
  trades: Trade[];
  filledQuantity: number;
}

/** Number of markets hydrated at startup. Used as a health metric. */
let hydratedMarketsCount = 0;

/** Returns how many markets were hydrated on cold start. */
export function getHydratedMarketsCount(): number {
  return hydratedMarketsCount;
}

class MatchingService {
  private books: Map<string, OrderBook> = new Map();
  private mutexes: Map<string, Mutex> = new Map();

  private getBookKey(marketId: string, outcome: Outcome): string {
    return `${marketId}:${outcome}`;
  }

  private getOrCreateMutex(key: string): Mutex {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.mutexes.set(key, mutex);
    }
    return mutex;
  }

  private async hydrateBook(
    marketId: string,
    outcome: Outcome
  ): Promise<OrderBook> {
    const prisma = getPrismaClient();
    const outcomeNum = outcomeToNumber(outcome);
    const bookKey = this.getBookKey(marketId, outcome);

    const book = new OrderBook(marketId, outcomeNum);

    const resting = await prisma.order.findMany({
      where: {
        marketId,
        outcome,
        status: { in: ["OPEN", "PARTIALLY_FILLED"] },
      },
      orderBy: [{ price: "asc" }, { createdAt: "asc" }],
    });

    for (const order of resting) {
      const remaining = order.quantity - order.filledQuantity;
      if (remaining <= 0) continue;

      book.addOrder({
        id: order.id,
        userAddress: order.userAddress,
        side: order.side === "BUY" ? "bid" : "ask",
        price: Number(order.price),
        quantity: remaining,
        timestamp: order.createdAt.getTime(),
        marketId,
        outcome: outcomeNum,
      });
    }

    this.books.set(bookKey, book);
    return book;
  }

  private invalidateBook(marketId: string, outcome: Outcome): void {
    const bookKey = this.getBookKey(marketId, outcome);
    this.books.delete(bookKey);
  }

  /**
   * Cancel an open order and release its locked collateral.
   *
   * 1. Validates the order exists, belongs to the caller, and is cancellable.
   * 2. Removes it from the in-memory order book (if present).
   * 3. Updates the DB row to CANCELLED status.
   * 4. Decrements the user's lockedCollateral for that market.
   *
   * @returns The cancelled order row.
   */
  async cancelOrder(orderId: string, userAddress: string): Promise<any> {
    const prisma = getPrismaClient();

    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
      });

      if (!order) {
        throw new ValidationError("Order not found", {
          orderId: "Order not found",
        });
      }

      if (order.userAddress !== userAddress) {
        throw new ValidationError("Order does not belong to this user", {
          orderId: "Order does not belong to this user",
        });
      }

      if (order.status !== "OPEN" && order.status !== "PARTIALLY_FILLED") {
        throw new ValidationError(
          `Order cannot be cancelled (status: ${order.status.toLowerCase()})`,
          {
            orderId: `Order cannot be cancelled (status: ${order.status.toLowerCase()})`,
          }
        );
      }

      // 2. Remove from in-memory order book
      const bookKey = this.getBookKey(order.marketId, order.outcome as Outcome);
      const book = this.books.get(bookKey);
      if (book) {
        const bookSide = order.side === "BUY" ? "bid" : "ask";
        book.removeOrder(orderId);
      }

      // 3. Update DB
      const remainingQty = order.quantity - order.filledQuantity;

      // 4. Release locked collateral (decrement)
      const collateralPerUnit =
        order.side === "BUY" ? Number(order.price) : 1 - Number(order.price);
      const collateralToRelease =
        Math.round(collateralPerUnit * remainingQty * 1e8) / 1e8;

      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: { status: "CANCELLED" },
      });

      if (collateralToRelease > 0) {
        // Decrement lockedCollateral for this user+market
        const position = await tx.userPosition.findUnique({
          where: {
            marketId_userAddress: {
              marketId: order.marketId,
              userAddress,
            },
          },
        });

        if (position) {
          const newLocked = Math.max(
            0,
            Number(position.lockedCollateral) - collateralToRelease
          );
          await tx.userPosition.update({
            where: {
              marketId_userAddress: {
                marketId: order.marketId,
                userAddress,
              },
            },
            data: {
              lockedCollateral: newLocked,
            },
          });
        }
      }

      return updatedOrder;
    });
  }

  /**
   * Hydrate order books for all active markets on cold start.
   * Loads OPEN/PARTIALLY_FILLED orders into in-memory books so the matching
   * engine is ready before the first request arrives, eliminating the
   * race window where restart leaves books empty against open DB orders.
   *
   * Configurable via WARM_MARKETS_ON_STARTUP env var (default: true).
   * Set WARM_MARKETS_ON_STARTUP=false to skip (e.g. in tests).
   */
  async hydrateAllActiveMarkets(): Promise<void> {
    if (process.env.WARM_MARKETS_ON_STARTUP === "false") return;

    const prisma = getPrismaClient();

    const markets = await prisma.market.findMany({
      where: { status: "ACTIVE" },
      select: { id: true },
    });

    const outcomes: Outcome[] = ["YES", "NO"];
    let count = 0;

    await Promise.all(
      markets.flatMap((m) =>
        outcomes.map(async (outcome) => {
          await this.hydrateBook(m.id, outcome);
          count++;
        })
      )
    );

    hydratedMarketsCount = markets.length;
    console.info(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        component: "matching-service",
        message: "Order books hydrated",
        markets: markets.length,
        books: count,
        metric: "orderbook.hydrated_markets",
        value: markets.length,
      })
    );
  }

  private async getOrHydrateBook(
    marketId: string,
    outcome: Outcome
  ): Promise<OrderBook> {
    const bookKey = this.getBookKey(marketId, outcome);
    let book = this.books.get(bookKey);

    if (!book) {
      book = await this.hydrateBook(marketId, outcome);
    }

    return book;
  }

  async placeOrder(input: OrderInput): Promise<PlaceOrderResult> {
    const bookKey = this.getBookKey(input.marketId, input.outcome);

    return this.getOrCreateMutex(bookKey).run(async () => {
      const prisma = getPrismaClient();
      const book = await this.getOrHydrateBook(input.marketId, input.outcome);

      // Self-trade check
      const userOrders = book.getOrdersByUser(input.userAddress);
      const hasOppositeResting = userOrders.some((o) => {
        const oppositeSide = input.side === "BUY" ? "ask" : "bid";
        return o.side === oppositeSide;
      });

      if (hasOppositeResting) {
        throw new ValidationError(
          "Self-trade: cannot match against your own resting order"
        );
      }

      const orderId = randomUUID();
      const timestamp = Date.now();

      const takerOrder: MatchingOrder = {
        id: orderId,
        userAddress: input.userAddress,
        side: input.side,
        price: input.price,
        quantity: input.quantity,
        marketId: input.marketId,
        outcome: input.outcome,
        timestamp,
      };

      const auditWrites: Promise<string | null>[] = [];
      const matchResult = matchOrder(takerOrder, book, {
        onTradeFilled: (trade) => {
          auditWrites.push(auditService.logOrderMatch(trade));
        },
      });

      let takerFilledQuantity =
        input.quantity - (matchResult.remainingOrder?.quantity ?? 0);

      let takerStatus: "OPEN" | "PARTIALLY_FILLED" | "FILLED";
      if (takerFilledQuantity === 0) {
        takerStatus = "OPEN";
      } else if (takerFilledQuantity < input.quantity) {
        takerStatus = "PARTIALLY_FILLED";
      } else {
        takerStatus = "FILLED";
      }

      let order: any;
      try {
        await prisma.$transaction(async (tx) => {
          // Create taker order
          order = await tx.order.create({
            data: {
              id: orderId,
              marketId: input.marketId,
              userAddress: input.userAddress,
              side: input.side,
              outcome: input.outcome,
              price: input.price.toString(),
              quantity: input.quantity,
              filledQuantity: takerFilledQuantity,
              status: takerStatus,
            },
          });

          // Update maker orders
          for (const trade of matchResult.trades) {
            const maker =
              trade.buyOrderId === orderId
                ? trade.sellOrderId
                : trade.buyOrderId;

            const makerOrder = await tx.order.findUnique({
              where: { id: maker },
              select: { quantity: true, filledQuantity: true },
            });

            if (!makerOrder) {
              throw new Error(`Maker order not found: ${maker}`);
            }

            const newFilledQty = makerOrder.filledQuantity + trade.quantity;

            let makerStatus: "OPEN" | "PARTIALLY_FILLED" | "FILLED";
            if (newFilledQty === 0) {
              makerStatus = "OPEN";
            } else if (newFilledQty < makerOrder.quantity) {
              makerStatus = "PARTIALLY_FILLED";
            } else {
              makerStatus = "FILLED";
            }

            await tx.order.update({
              where: { id: maker },
              data: {
                filledQuantity: newFilledQty,
                status: makerStatus,
              },
            });
          }

          // Persist trades as source of truth (idempotent on trade.id)
          for (const trade of matchResult.trades) {
            await tx.trade.upsert({
              where: { tradeId: trade.id },
              create: {
                tradeId: trade.id,
                marketId: trade.marketId,
                outcome: trade.outcome,
                buyerAddress: trade.buyerAddress,
                sellerAddress: trade.sellerAddress,
                buyOrderId: trade.buyOrderId,
                sellOrderId: trade.sellOrderId,
                price: trade.price.toString(),
                quantity: trade.quantity,
                tradedAt: new Date(trade.timestamp),
              },
              update: {},
            });
          }

          // Build collateral cost-basis deltas: buyer pays price*qty, seller receives it
          const collateralDeltaMap = new Map<string, number>();
          for (const trade of matchResult.trades) {
            const cost = trade.price * trade.quantity;
            collateralDeltaMap.set(
              trade.buyerAddress,
              (collateralDeltaMap.get(trade.buyerAddress) ?? 0) + cost
            );
            collateralDeltaMap.set(
              trade.sellerAddress,
              (collateralDeltaMap.get(trade.sellerAddress) ?? 0) - cost
            );
          }

          // Update positions
          for (const delta of matchResult.positionDeltas) {
            const collateralDelta =
              collateralDeltaMap.get(delta.userAddress) ?? 0;
            await tx.userPosition.upsert({
              where: {
                marketId_userAddress: {
                  marketId: input.marketId,
                  userAddress: delta.userAddress,
                },
              },
              create: {
                marketId: input.marketId,
                userAddress: delta.userAddress,
                yesShares: delta.yesSharesDelta,
                noShares: delta.noSharesDelta,
                lockedCollateral: collateralDelta,
              },
              update: {
                yesShares: {
                  increment: delta.yesSharesDelta,
                },
                noShares: {
                  increment: delta.noSharesDelta,
                },
                lockedCollateral: {
                  increment: collateralDelta,
                },
              },
            });
          }
        });
      } catch (error) {
        this.invalidateBook(input.marketId, input.outcome);
        throw error;
      }

      // After successful commit:
      // 1. Add remaining order to book if any
      if (matchResult.remainingOrder) {
        book.addOrder({
          id: matchResult.remainingOrder.id,
          userAddress: matchResult.remainingOrder.userAddress,
          side: input.side === "BUY" ? "bid" : "ask",
          price: matchResult.remainingOrder.price,
          quantity: matchResult.remainingOrder.quantity,
          timestamp: matchResult.remainingOrder.timestamp,
          marketId: input.marketId,
          outcome: outcomeToNumber(input.outcome),
        });
      }

      // 2. Log trades to audit before returning control to the caller
      await Promise.all(auditWrites);

      // 3. Enqueue settlement jobs with proper error handling
      const settlementErrors: Array<{ tradeId: string; error: Error }> = [];
      for (const trade of matchResult.trades) {
        try {
          await settlementQueue.enqueue({
            tradeId: trade.id,
            marketId: trade.marketId,
            outcome: trade.outcome,
            buyOrderId: trade.buyOrderId,
            sellOrderId: trade.sellOrderId,
            buyerAddress: trade.buyerAddress,
            sellerAddress: trade.sellerAddress,
            price: trade.price,
            quantity: trade.quantity,
            timestamp: trade.timestamp,
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          settlementErrors.push({ tradeId: trade.id, error: err });
          console.error(
            JSON.stringify({
              level: "error",
              component: "matching-service",
              action: "settlement_enqueue_failed",
              tradeId: trade.id,
              buyOrderId: trade.buyOrderId,
              sellOrderId: trade.sellOrderId,
              message: err.message,
              stack: err.stack,
            })
          );
        }
      }

      // 4. Refresh Redis cache with proper error handling
      try {
        const depth = book.getDepth(20);
        await redis.setOrderBook(input.marketId, input.outcome, {
          bids: depth.bids.map((d) => ({
            price: d.price,
            quantity: d.quantity,
          })),
          asks: depth.asks.map((d) => ({
            price: d.price,
            quantity: d.quantity,
          })),
          timestamp: Date.now(),
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(
          JSON.stringify({
            level: "error",
            component: "matching-service",
            action: "redis_orderbook_update_failed",
            marketId: input.marketId,
            outcome: input.outcome,
            message: err.message,
            stack: err.stack,
          })
        );
      }

      return {
        order,
        trades: matchResult.trades,
        filledQuantity: takerFilledQuantity,
      };
    });
  }
}

export const matchingService = new MatchingService();
