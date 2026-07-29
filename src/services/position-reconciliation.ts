import { getPrismaClient } from "./prisma.js";
import type { UserPosition, Prisma } from "../generated/prisma/client/index.js";
import { Decimal } from "@prisma/client/runtime/library.js";

export interface ComputedPosition {
  yesShares: number;
  noShares: number;
  lockedCollateral: Decimal;
}

export interface DriftRecord {
  expected: ComputedPosition;
  actual: {
    yesShares: number;
    noShares: number;
    lockedCollateral: Decimal;
  };
  divergence: {
    yesSharesDiff: number;
    noSharesDiff: number;
    lockedCollateralDiff: Decimal;
  };
}

export interface ReconciliationResult {
  hasDrift: boolean;
  divergence: DriftRecord | null;
  recovered: boolean;
  recoveryReason?: string;
}

export interface BulkReconciliationResult {
  marketId: string;
  totalWallets: number;
  driftCount: number;
  recoveredCount: number;
  failedCount: number;
  duration: number;
}

export interface DepositReconciliationResult {
  pending: number;
  reconciled: number;
  failed: number;
}

export class PositionReconciliationService {
  /**
   * Compute expected position from indexed events (trades + deposits)
   */
  private async computeExpectedPosition(
    wallet: string,
    marketId: string
  ): Promise<ComputedPosition> {
    const prisma = getPrismaClient();

    const trades = await prisma.indexedTrade.findMany({
      where: {
        marketId,
        OR: [{ traderAddress: wallet }, { counterpartyAddress: wallet }],
      },
      orderBy: { ledger: "asc" },
    });

    const deposits = await prisma.collateralDeposit.findMany({
      where: {
        marketId,
        account: wallet,
      },
      orderBy: { ledger: "asc" },
    });

    let yesShares = 0;
    let noShares = 0;
    let lockedCollateral = new Decimal(0);

    // Apply deposit deltas
    for (const deposit of deposits) {
      lockedCollateral = lockedCollateral.plus(new Decimal(deposit.amountRaw));
    }

    // Apply trade deltas
    for (const trade of trades) {
      const quantity = parseInt(trade.quantityRaw, 10);
      const isTrader = trade.traderAddress === wallet;

      if (trade.outcome === "YES") {
        if (isTrader) {
          yesShares += quantity;
        } else {
          noShares += quantity;
        }
      } else {
        // NO outcome
        if (isTrader) {
          noShares += quantity;
        } else {
          yesShares += quantity;
        }
      }
    }

    return {
      yesShares,
      noShares,
      lockedCollateral,
    };
  }

  /**
   * Detect drift between expected and actual positions
   */
  private detectDrift(
    expected: ComputedPosition,
    actual: UserPosition
  ): { hasDrift: boolean; divergence: DriftRecord } {
    const yesSharesDiff = expected.yesShares - actual.yesShares;
    const noSharesDiff = expected.noShares - actual.noShares;
    const lockedDiff = expected.lockedCollateral.minus(
      actual.lockedCollateral
    );

    const hasDrift =
      yesSharesDiff !== 0 || noSharesDiff !== 0 || !lockedDiff.isZero();

    return {
      hasDrift,
      divergence: {
        expected,
        actual: {
          yesShares: actual.yesShares,
          noShares: actual.noShares,
          lockedCollateral: actual.lockedCollateral,
        },
        divergence: {
          yesSharesDiff,
          noSharesDiff,
          lockedCollateralDiff: lockedDiff,
        },
      },
    };
  }

  /**
   * Apply recovery atomically: recompute from events and update position
   */
  private async applyRecovery(
    wallet: string,
    marketId: string,
    expectedPosition: ComputedPosition
  ): Promise<void> {
    const prisma = getPrismaClient();

    await prisma.$transaction(async (tx) => {
      // Lock the row
      const position = await tx.userPosition.findUnique({
        where: { marketId_userAddress: { marketId, userAddress: wallet } },
      });

      if (!position) {
        // Create if doesn't exist
        await tx.userPosition.create({
          data: {
            marketId,
            userAddress: wallet,
            yesShares: expectedPosition.yesShares,
            noShares: expectedPosition.noShares,
            lockedCollateral: expectedPosition.lockedCollateral,
          },
        });
      } else {
        // Update to expected
        await tx.userPosition.update({
          where: {
            marketId_userAddress: { marketId, userAddress: wallet },
          },
          data: {
            yesShares: expectedPosition.yesShares,
            noShares: expectedPosition.noShares,
            lockedCollateral: expectedPosition.lockedCollateral,
          },
        });
      }
    });
  }

  /**
   * Reconcile a single wallet/market pair
   */
  async reconcile(
    wallet: string,
    marketId: string,
    autoRecovery: boolean = false
  ): Promise<ReconciliationResult> {
    const prisma = getPrismaClient();

    try {
      const actual = await prisma.userPosition.findUnique({
        where: { marketId_userAddress: { marketId, userAddress: wallet } },
      });

      const expected = await this.computeExpectedPosition(wallet, marketId);

      if (!actual) {
        // Position doesn't exist but events do
        const hasEvents =
          expected.yesShares > 0 ||
          expected.noShares > 0 ||
          expected.lockedCollateral.isPositive();

        if (hasEvents) {
          if (autoRecovery) {
            await this.applyRecovery(wallet, marketId, expected);
            return {
              hasDrift: true,
              divergence: {
                expected,
                actual: {
                  yesShares: 0,
                  noShares: 0,
                  lockedCollateral: new Decimal(0),
                },
                divergence: {
                  yesSharesDiff: expected.yesShares,
                  noSharesDiff: expected.noShares,
                  lockedCollateralDiff: expected.lockedCollateral,
                },
              },
              recovered: true,
              recoveryReason: "Position created from events",
            };
          }

          return {
            hasDrift: true,
            divergence: {
              expected,
              actual: {
                yesShares: 0,
                noShares: 0,
                lockedCollateral: new Decimal(0),
              },
              divergence: {
                yesSharesDiff: expected.yesShares,
                noSharesDiff: expected.noShares,
                lockedCollateralDiff: expected.lockedCollateral,
              },
            },
            recovered: false,
          };
        }

        return {
          hasDrift: false,
          divergence: null,
          recovered: false,
        };
      }

      const { hasDrift, divergence } = this.detectDrift(expected, actual);

      if (hasDrift && autoRecovery) {
        await this.applyRecovery(wallet, marketId, expected);
        return {
          hasDrift: true,
          divergence,
          recovered: true,
          recoveryReason: "Position updated to match events",
        };
      }

      return {
        hasDrift,
        divergence: hasDrift ? divergence : null,
        recovered: false,
      };
    } catch (error) {
      console.error(
        `Failed to reconcile ${wallet} for market ${marketId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Reconcile all wallets in a market
   */
  async reconcileMarket(
    marketId: string,
    autoRecovery: boolean = false
  ): Promise<BulkReconciliationResult> {
    const prisma = getPrismaClient();
    const startTime = performance.now();

    try {
      // Find all unique wallets for this market
      const traderAddresses = await prisma.indexedTrade.findMany({
        where: { marketId },
        select: { traderAddress: true },
        distinct: ["traderAddress"],
      });

      const counterpartyAddresses = await prisma.indexedTrade.findMany({
        where: { marketId },
        select: { counterpartyAddress: true },
        distinct: ["counterpartyAddress"],
      });

      const depositWallets = await prisma.collateralDeposit.findMany({
        where: { marketId },
        select: { account: true },
        distinct: ["account"],
      });

      const walletSet = new Set([
        ...traderAddresses.map((r) => r.traderAddress),
        ...counterpartyAddresses.map((r) => r.counterpartyAddress),
        ...depositWallets.map((r) => r.account),
      ]);

      let driftCount = 0;
      let recoveredCount = 0;
      let failedCount = 0;

      for (const wallet of walletSet) {
        try {
          const result = await this.reconcile(wallet, marketId, autoRecovery);
          if (result.hasDrift) {
            driftCount++;
            if (result.recovered) {
              recoveredCount++;
            }
          }

          // Log reconciliation job
          await prisma.positionReconciliationJob.create({
            data: {
              marketId,
              wallet,
              driftDetected: result.hasDrift,
              divergence: result.divergence as any,
              recoveryApplied: result.recovered,
              recoveryReason: result.recoveryReason,
              completedAt: new Date(),
            },
          });
        } catch (error) {
          failedCount++;
          console.error(
            `Failed to reconcile wallet ${wallet} for market ${marketId}:`,
            error
          );
        }
      }

      const duration = performance.now() - startTime;

      return {
        marketId,
        totalWallets: walletSet.size,
        driftCount,
        recoveredCount,
        failedCount,
        duration,
      };
    } catch (error) {
      console.error(`Failed to reconcile market ${marketId}:`, error);
      throw error;
    }
  }

  /**
   * Reconcile deposits: check which deposits have been reflected in positions
   */
  async reconcileDeposits(
    marketId: string,
    wallet?: string
  ): Promise<DepositReconciliationResult> {
    const prisma = getPrismaClient();

    try {
      const where: Prisma.CollateralDepositWhereInput = {
        marketId,
        ...(wallet ? { account: wallet } : {}),
      };

      const deposits = await prisma.collateralDeposit.findMany({
        where,
      });

      let reconciled = 0;
      let failed = 0;

      for (const deposit of deposits) {
        try {
          const idempotencyKey = `deposit:${deposit.id}`;

          // Check if already reconciled
          const existing = await prisma.depositReconciliation.findUnique({
            where: { idempotencyKey },
          });

          if (existing && existing.status === "APPLIED") {
            reconciled++;
            continue;
          }

          // Check if position reflects this deposit
          const position = await prisma.userPosition.findUnique({
            where: {
              marketId_userAddress: {
                marketId,
                userAddress: deposit.account,
              },
            },
          });

          const depositAmount = new Decimal(deposit.amountRaw);

          if (position && position.lockedCollateral.gte(depositAmount)) {
            // Deposit is reflected
            await prisma.depositReconciliation.upsert({
              where: { idempotencyKey },
              create: {
                idempotencyKey,
                depositId: deposit.id,
                wallet: deposit.account,
                marketId,
                amountRaw: deposit.amountRaw,
                status: "APPLIED",
                appliedAt: new Date(),
              },
              update: {
                status: "APPLIED",
                appliedAt: new Date(),
              },
            });
            reconciled++;
          } else {
            // Deposit not yet reflected
            await prisma.depositReconciliation.upsert({
              where: { idempotencyKey },
              create: {
                idempotencyKey,
                depositId: deposit.id,
                wallet: deposit.account,
                marketId,
                amountRaw: deposit.amountRaw,
                status: "PENDING_RECONCILE",
                reconciliationAttempts: 1,
                lastAttemptAt: new Date(),
              },
              update: {
                reconciliationAttempts: {
                  increment: 1,
                },
                lastAttemptAt: new Date(),
              },
            });
          }
        } catch (error) {
          failed++;
          console.error(
            `Failed to reconcile deposit ${deposit.id}:`,
            error
          );
        }
      }

      return {
        pending: deposits.length - reconciled - failed,
        reconciled,
        failed,
      };
    } catch (error) {
      console.error(`Failed to reconcile deposits for market ${marketId}:`, error);
      throw error;
    }
  }
}

export const positionReconciliationService =
  new PositionReconciliationService();
