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
import {
  ValidationError,
  ServiceUnavailableError,
  MarketNotFoundError,
  MarketNotActiveError,
} from "../api/middleware/errors.js";
import { orderbookHydratedMarketsGauge } from "../services/metrics.js";

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

/**
 * Feature flag (#744): whether the matching engine accepts and matches new
 * orders. Read directly from process.env (like WARM_MARKETS_ON_STARTUP
 * above) rather than via src/config.js, so importing this module never
 * forces a boot-time DATABASE_URL validation — tests that mock
 * services/prisma.js can still import matching-service.ts without a real
 * database configured. The canonical, validated boolean is parsed at server
 * startup in src/env.ts / src/config.ts (config.matchingEngineEnabled) so
 * malformed values still fail fast before the process binds a port.
 */
export function isMatchingEngineEnabled(): boolean {
  return process.env.MATCHING_ENGINE_ENABLED !== "false";
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
    this.syncHydratedMarketsGauge();
    return book;
  }

  private invalidateBook(marketId: string, outcome: Outcome): void {
    const bookKey = this.getBookKey(marketId, outcome);
    this.books.delete(bookKey);
    this.syncHydratedMarketsGauge();
  }

  /** Keeps the orderbook_hydrated_markets gauge in sync with in-memory book count (#746). */
  private syncHydratedMarketsGauge(): void {
    orderbookHydratedMarketsGauge.set(this.books.size);
  }

  /**
   * Cancel an open order and release its locked collateral.
   *
   * Runs under the same per-book mutex as `placeOrder` (#866) so a cancel
   * can never interleave in-memory with a match for the same book on this
   * instance. That mutex is a single-instance optimization only — the
   * authoritative safety net is the version-conditioned UPDATE below: it
   * conditions on the exact (version, status) this call read, so even a
   * true concurrent writer (another process, or a match whose in-memory
   * work raced ahead of its DB commit) can only ever have one of the two
   * conflicting writes succeed. The loser gets OrderConflictError (409),
   * a documented, retryable error code.
   *
   * 1. Validates the order exists, belongs to the caller, and is cancellable.
   * 2. Updates the DB row to CANCELLED status, conditioned on version+status.
   * 3. Decrements the user's lockedCollateral for that market (remaining
   *    unfilled quantity only; never below zero).
   * 4. Removes it from the in-memory order book, only after the DB commit.
   *
   * @returns The cancelled order row.
   */
  async cancelOrder(orderId: string, userAddress: string): Promise<any> {
    const prisma = getPrismaClient();

    // marketId/outcome are immutable once an order is created, so this
    // lookup is safe to do before acquiring the per-book mutex — it only
    // determines *which* mutex to take.
    const orderRef = await prisma.order.findUnique({
      where: { id: orderId },
      select: { marketId: true, outcome: true },
    });

    if (!orderRef) {
      throw new ValidationError("Order not found", {
        orderId: "Order not found",
      });
    }

    const marketId = orderRef.marketId;
    const outcome = orderRef.outcome as Outcome;
    const bookKey = this.getBookKey(marketId, outcome);

    return this.getOrCreateMutex(bookKey).run(async () => {
      let cancelledOrder: any;

      try {
        cancelledOrder = await prisma.$transaction(async (tx) => {
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

          // Conditional cancel: only applies if the row is still exactly the
          // version/status we just read. Zero rows affected means a
          // concurrent writer (fill or cancel) already landed first.
          const cancelResult = await tx.order.updateMany({
            where: {
              id: orderId,
              version: order.version,
              status: { in: ["OPEN", "PARTIALLY_FILLED"] },
            },
            data: {
              status: "CANCELLED",
              version: { increment: 1 },
            },
          });

          if (cancelResult.count === 0) {
            throw new OrderConflictError(
              "Order was concurrently filled or cancelled; please retry"
            );
          }

          // Release locked collateral for the remaining unfilled quantity only.
          const remainingQty = order.quantity - order.filledQuantity;
          const collateralPerUnit =
            order.side === "BUY"
              ? Number(order.price)
              : 1 - Number(order.price);
          const collateralToRelease =
            Math.round(collateralPerUnit * remainingQty * 1e8) / 1e8;

          if (collateralToRelease > 0) {
            const position = await tx.userPosition.findUnique({
              where: {
                marketId_userAddress: {
                  marketId: order.marketId,
                  userAddress,
                },
              },
            });

            if (position) {
              // Never release more than is actually locked.
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

          return { ...order, status: "CANCELLED", version: order.version + 1 };
        });
      } catch (error) {
        if (error instanceof OrderConflictError) {
          // Our in-memory book may be stale relative to the write that beat
          // us (e.g. a fill applied by another instance) — evict it so the
          // next operation for this book rehydrates fresh from the DB.
          this.invalidateBook(marketId, outcome);
        }
        throw error;
      }

      // Only mutate the in-memory book once the cancel is durably committed.
      const book = this.books.get(bookKey);
      if (book) {
        book.removeOrder(orderId);
      }

      return cancelledOrder;
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
   *
   * Also skipped when the matching engine is disabled via
   * MATCHING_ENGINE_ENABLED=false (#744) — there is nothing useful to warm
   * if order placement itself will be rejected.
   */
  async hydrateAllActiveMarkets(): Promise<void> {
    if (!isMatchingEngineEnabled()) return;
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

  /**
   * Places (and attempts to match) an order.
   *
   * Rejects with 503 when the matching engine is disabled via
   * MATCHING_ENGINE_ENABLED=false (#744). Order cancellation is unaffected —
   * users can still withdraw resting orders while matching is paused.
   *
   * Re-checks market status inside the per-book mutex (#792), even though
   * routes already call assertValidOrder before this. A market can flip to
   * CANCELLED/RESOLVED while an order is queued behind the mutex, so the
   * service itself must reject rather than trust the pre-check.
   */
  async placeOrder(input: OrderInput): Promise<PlaceOrderResult> {
    if (!isMatchingEngineEnabled()) {
      throw new ServiceUnavailableError("Matching engine is disabled");
    }

    const bookKey = this.getBookKey(input.marketId, input.outcome);

    return this.getOrCreateMutex(bookKey).run(async () => {
      const prisma = getPrismaClient();

      const market = await prisma.market.findUnique({
        where: { id: input.marketId },
      });

      if (!market || market.deletedAt !== null) {
        throw new MarketNotFoundError(input.marketId);
      }

      if (market.status !== "ACTIVE") {
        throw new MarketNotActiveError(input.marketId, market.status);
      }

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
              select: {
                quantity: true,
                filledQuantity: true,
                status: true,
                version: true,
              },
            });

            if (!makerOrder) {
              throw new Error(`Maker order not found: ${maker}`);
            }

            // The in-memory book that produced this match may be stale
            // relative to the DB (e.g. the maker order was cancelled, or
            // filled by another instance, after this book last hydrated).
            // Reject rather than fill a maker order that is no longer open
            // (#866) — no fill may commit against a canceled maker order.
            if (
              makerOrder.status !== "OPEN" &&
              makerOrder.status !== "PARTIALLY_FILLED"
            ) {
              throw new OrderConflictError(
                `Maker order ${maker} is no longer open (status: ${makerOrder.status.toLowerCase()}); please retry`
              );
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

            // Conditional update: only applies if the maker order is still
            // exactly the version/status just read. Zero rows affected means
            // a concurrent cancel (or another fill) beat this transaction to
            // it — the whole placeOrder transaction rolls back, so there is
            // one winner per maker order version and never a double-fill.
            const makerUpdate = await tx.order.updateMany({
              where: {
                id: maker,
                version: makerOrder.version,
                status: { in: ["OPEN", "PARTIALLY_FILLED"] },
              },
              data: {
                filledQuantity: newFilledQty,
                status: makerStatus,
                version: { increment: 1 },
              },
            });

            if (makerUpdate.count === 0) {
              throw new OrderConflictError(
                `Maker order ${maker} was concurrently modified; please retry`
              );
            }
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
