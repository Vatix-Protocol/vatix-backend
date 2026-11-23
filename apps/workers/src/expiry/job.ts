import { Decimal } from "@prisma/client/runtime/client.js";
import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import type { ExpiryJobResult, ExpiryCandidateResult } from "./types.js";
import { DEFAULT_EXPIRY_CLOCK_SKEW_TOLERANCE_MS } from "./config.js";
import {
  computeCollateralToRelease,
  COLLATERAL_DECIMALS,
} from "../../../../src/matching/collateral.js";

/**
 * Collateral is rounded to the on-chain scale (7 fractional digits), not the
 * wider Decimal(20, 8) column width — see COLLATERAL_SCALE in decimalUtils.ts,
 * the single source of truth shared by the indexer, this expiry/cancel path,
 * and the matching-service cancel path (#1549). The Prisma column keeps
 * extra precision, but rounding here must match the 7-decimal on-chain unit:
 * rounding to 8 digits here would let a value be "exact" at 8 decimals while
 * being off by up to 9e-8 at the on-chain 7-decimal scale.
 */
const ONE = new Decimal(1);
const ZERO = new Decimal(0);

/**
 * Thrown inside the expiry transaction when an open order cannot have its
 * collateral released (missing position row or position shortfall). Rolls
 * back the transaction so the market is not flipped to a terminal status.
 */
class OrderCollateralReleaseError extends Error {
  constructor(
    readonly orderId: string,
    readonly reason: "missing_position" | "position_shortfall",
    message: string
  ) {
    super(message);
    this.name = "OrderCollateralReleaseError";
  }
}

export interface ExpiryJobConfig {
  maxRunMs?: number;
  /**
   * Grace period (ms) subtracted from "now" before comparing against
   * `market.endTime`. Guards against the host container clock running
   * fast relative to the Stellar ledger's close time: if the host clock is
   * ahead, `Date.now()` can cross a market's endTime before the ledger
   * actually reaches it, causing the job to cancel orders and lock in
   * expiry on a market that is not actually expired on-chain yet. A
   * market is only treated as a candidate once `endTime <= now - tolerance`.
   * Defaults to `DEFAULT_EXPIRY_CLOCK_SKEW_TOLERANCE_MS` (5000ms), never 0.
   */
  clockSkewToleranceMs?: number;
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

/**
 * Expires ACTIVE markets whose `endTime` has passed: cancels their open
 * orders, releases locked collateral and marks the market CANCELLED.
 *
 * Expiry and operator cancel share one status today: this job writes
 * `CANCELLED` (there is no separate EXPIRED state), so an expired market is
 * indistinguishable from an operator-cancelled one by status alone.
 */
export class ExpiryJob {
  private readonly maxRunMs: number;
  private readonly clockSkewToleranceMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: ILogger,
    config: ExpiryJobConfig
  ) {
    this.maxRunMs = config.maxRunMs ?? 0;
    this.clockSkewToleranceMs =
      config.clockSkewToleranceMs ?? DEFAULT_EXPIRY_CLOCK_SKEW_TOLERANCE_MS;
  }

  async run(): Promise<ExpiryJobResult> {
    const startedAt = new Date();
    const now = new Date();
    const runId = `expiry-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
    const expiryThreshold = new Date(now.getTime() - this.clockSkewToleranceMs);

    this.logger.info("Expiry job started", {
      runId,
      now: now.toISOString(),
      clockSkewToleranceMs: this.clockSkewToleranceMs,
      expiryThreshold: expiryThreshold.toISOString(),
    });

    let candidates: ExpireyMarket[];

    try {
      candidates = await this.prisma.market.findMany({
        where: {
          status: "ACTIVE",
          endTime: { lte: expiryThreshold },
          deletedAt: null,
        },
        select: {
          id: true,
          endTime: true,
        },
      });
    } catch (error) {
      this.logger.error("Expiry job failed to query candidates", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      const completedAt = new Date();
      return {
        totalCandidates: 0,
        expiredCount: 0,
        skippedCount: 0,
        erroredCount: 1,
        queryFailed: true,
        truncated: false,
        unprocessedCount: 0,
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
    let truncated = false;
    let unprocessedCount = 0;

    for (const market of candidates) {
      if (
        this.maxRunMs > 0 &&
        Date.now() - startedAt.getTime() >= this.maxRunMs
      ) {
        truncated = true;
        unprocessedCount = candidates.length - results.length;
        this.logger.warn("Expiry job exceeded maxRunMs, stopping early", {
          maxRunMs: this.maxRunMs,
          processedSoFar: results.length,
          remainingCandidates: unprocessedCount,
        });
        break;
      }

      try {
        const result = await this.expireMarket(market.id, now);
        results.push(result);
      } catch (error) {
        if (error instanceof OrderCollateralReleaseError) {
          this.logger.error("Expiry job aborted: order collateral not released", {
            marketId: market.id,
            orderId: error.orderId,
            reason: error.reason,
            error: error.message,
          });
          results.push({
            marketId: market.id,
            status: "errored",
            ordersCount: 0,
            collateralReleased: 0,
            errorMessage: error.message,
          });
        } else if (error instanceof MarketNotEligibleError) {
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
      runId,
      totalCandidates: candidates.length,
      expiredCount,
      erroredCount,
      skippedCount,
      truncated,
      unprocessedCount,
      durationMs: completedAt.getTime() - startedAt.getTime(),
    });

    return {
      totalCandidates: candidates.length,
      expiredCount,
      erroredCount,
      skippedCount,
      queryFailed: false,
      truncated,
      unprocessedCount,
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

      let totalCollateralReleased = new Decimal(0);

      for (const order of openOrders) {
        const remainingQty = order.quantity - order.filledQuantity;
        const collateralToRelease = computeCollateralToRelease(
          order.side,
          order.price.toString(),
          remainingQty
        );

        if (collateralToRelease.greaterThan(ZERO)) {
          const position = await tx.userPosition.findUnique({
            where: {
              marketId_userAddress: {
                marketId,
                userAddress: order.userAddress,
              },
            },
          });

          if (!position) {
            throw new OrderCollateralReleaseError(
              order.id,
              "missing_position",
              `Order ${order.id} has no position row for ${order.userAddress}; cannot release ${collateralToRelease.toString()} collateral`
            );
          }

          const lockedCollateral = new Decimal(
            position.lockedCollateral.toString()
          );
          if (lockedCollateral.lessThan(collateralToRelease)) {
            throw new OrderCollateralReleaseError(
              order.id,
              "position_shortfall",
              `Order ${order.id} position lockedCollateral ${lockedCollateral.toString()} is less than collateral to release ${collateralToRelease.toString()}`
            );
          }

          const newLocked = lockedCollateral
            .minus(collateralToRelease)
            .toDecimalPlaces(COLLATERAL_DECIMALS, Decimal.ROUND_HALF_UP);

          await tx.userPosition.update({
            where: {
              marketId_userAddress: {
                marketId,
                userAddress: order.userAddress,
              },
            },
            data: { lockedCollateral: newLocked },
          });

          // Only count collateral that was actually persisted.
          totalCollateralReleased = totalCollateralReleased.plus(
            collateralToRelease
          );
        }

        await tx.order.update({
          where: { id: order.id },
          data: { status: "CANCELLED" },
        });
      }

      // A market that simply reached endTime is EXPIRED, not CANCELLED: an
      // operator cancel must stay distinguishable from a natural expiry (#1478).
      await tx.market.update({
        where: { id: marketId },
        data: { status: "EXPIRED" },
      });

      return {
        marketId,
        status: "expired",
        ordersCount: openOrders.length,
        collateralReleased: totalCollateralReleased.toNumber(),
      };
    });
  }
}
