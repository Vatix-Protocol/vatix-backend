import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import type {
  ExpiryJobResult,
  ExpiryCandidateResult,
} from "./types.js";

export interface ExpiryJobConfig {
  maxRunMs?: number;
}

interface ExpireyMarket {
  id: string;
  endTime: Date;
}

/**
 * Thrown inside the expiry transaction when the target market was
 * transitioned to non-ACTIVE status or soft-deleted after the candidate
 * query ran. Rolls back the transaction and is translated into a "skipped"
 * result rather than "errored", since this is expected concurrent state.
 */
class MarketNotEligibleError extends Error {
  constructor(marketId: string) {
    super(`Market ${marketId} is not eligible; skipping expiry`);
    this.name = "MarketNotEligibleError";
  }
}

export class ExpiryJob {
  private readonly maxRunMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: ILogger,
    config: ExpiryJobConfig
  ) {
    this.maxRunMs = config.maxRunMs ?? 0;
  }

  async run(): Promise<ExpiryJobResult> {
    const startedAt = new Date();
    const now = new Date();

    this.logger.info("Expiry job started", {
      now: now.toISOString(),
    });

    let candidates: ExpireyMarket[];

    try {
      candidates = await this.prisma.market.findMany({
        where: {
          status: "ACTIVE",
          endTime: { lte: now },
          deletedAt: null,
        },
        select: {
          id: true,
          endTime: true,
        },
      });
    } catch (error) {
      this.logger.error("Expiry job failed to query candidates", {
        error: error instanceof Error ? error.message : String(error),
      });
      const completedAt = new Date();
      return {
        totalCandidates: 0,
        expiredCount: 0,
        skippedCount: 0,
        erroredCount: 0,
        candidates: [],
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
      };
    }

    this.logger.info("Expiry job selected candidates", {
      count: candidates.length,
    });

    const results: ExpiryCandidateResult[] = [];

    for (const market of candidates) {
      if (this.maxRunMs > 0 && Date.now() - startedAt.getTime() >= this.maxRunMs) {
        this.logger.warn("Expiry job exceeded maxRunMs, stopping early", {
          maxRunMs: this.maxRunMs,
          processedSoFar: results.length,
          remainingCandidates: candidates.length - results.length,
        });
        break;
      }

      try {
        const result = await this.expireMarket(market.id, now);
        results.push(result);
      } catch (error) {
        if (error instanceof MarketNotEligibleError) {
          this.logger.debug("Market not eligible for expiry", {
            marketId: market.id,
          });
          results.push({
            marketId: market.id,
            status: "skipped",
            ordersCount: 0,
            collateralReleased: 0,
          });
        } else {
          this.logger.error("Expiry job failed to expire market", {
            marketId: market.id,
            error: error instanceof Error ? error.message : String(error),
          });
          results.push({
            marketId: market.id,
            status: "errored",
            ordersCount: 0,
            collateralReleased: 0,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const completedAt = new Date();
    const expiredCount = results.filter((r) => r.status === "expired").length;
    const erroredCount = results.filter((r) => r.status === "errored").length;
    const skippedCount = results.filter((r) => r.status === "skipped").length;

    this.logger.info("Expiry job completed", {
      totalCandidates: candidates.length,
      expiredCount,
      erroredCount,
      skippedCount,
      durationMs: completedAt.getTime() - startedAt.getTime(),
    });

    return {
      totalCandidates: candidates.length,
      expiredCount,
      erroredCount,
      skippedCount,
      candidates: results,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
    };
  }

  private async expireMarket(
    marketId: string,
    now: Date
  ): Promise<ExpiryCandidateResult> {
    return this.prisma.$transaction(async (tx) => {
      const market = await tx.market.findUnique({
        where: { id: marketId },
      });

      if (!market || market.status !== "ACTIVE" || market.deletedAt !== null) {
        throw new MarketNotEligibleError(marketId);
      }

      const openOrders = await tx.order.findMany({
        where: {
          marketId,
          status: { in: ["OPEN", "PARTIALLY_FILLED"] },
        },
        select: {
          id: true,
          userAddress: true,
          side: true,
          price: true,
          quantity: true,
          filledQuantity: true,
          outcome: true,
        },
      });

      let totalCollateralReleased = 0;

      for (const order of openOrders) {
        const remainingQty = order.quantity - order.filledQuantity;
        const collateralPerUnit =
          order.side === "BUY"
            ? Number(order.price)
            : 1 - Number(order.price);
        const collateralToRelease =
          Math.round(collateralPerUnit * remainingQty * 1e8) / 1e8;

        totalCollateralReleased += collateralToRelease;

        await tx.order.update({
          where: { id: order.id },
          data: { status: "CANCELLED" },
        });

        if (collateralToRelease > 0) {
          const position = await tx.userPosition.findUnique({
            where: {
              marketId_userAddress: {
                marketId,
                userAddress: order.userAddress,
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
                  marketId,
                  userAddress: order.userAddress,
                },
              },
              data: { lockedCollateral: newLocked },
            });
          }
        }
      }

      await tx.market.update({
        where: { id: marketId },
        data: { status: "CANCELLED" },
      });

      return {
        marketId,
        status: "expired",
        ordersCount: openOrders.length,
        collateralReleased: totalCollateralReleased,
      };
    });
  }
}
