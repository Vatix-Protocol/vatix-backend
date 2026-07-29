import type ILogger from "../../../../packages/shared/src/logger.js";
import {
  positionReconciliationService,
  type BulkReconciliationResult,
} from "../../../src/services/position-reconciliation.js";
import { getPrismaClient } from "../../../src/services/prisma.js";
import type { ReconciliationJobResult } from "./types.js";

export class ReconciliationJob {
  private readonly logger: ILogger;
  private readonly maxRunMs: number;
  private readonly autoRecoveryEnabled: boolean;

  constructor(
    logger: ILogger,
    maxRunMs: number,
    autoRecoveryEnabled: boolean
  ) {
    this.logger = logger;
    this.maxRunMs = maxRunMs;
    this.autoRecoveryEnabled = autoRecoveryEnabled;
  }

  async run(): Promise<ReconciliationJobResult> {
    const startTime = performance.now();

    try {
      const prisma = getPrismaClient();

      // Query all markets with status ACTIVE or RESOLVED
      const markets = await prisma.market.findMany({
        where: {
          status: { in: ["ACTIVE", "RESOLVED"] },
          deletedAt: null,
        },
        select: { id: true },
        orderBy: { createdAt: "desc" },
      });

      this.logger.info("Reconciliation job started", {
        marketCount: markets.length,
        autoRecoveryEnabled: this.autoRecoveryEnabled,
      });

      const results: BulkReconciliationResult[] = [];
      let failedMarkets = 0;

      for (const market of markets) {
        // Check if we've exceeded maxRunMs
        const elapsedMs = performance.now() - startTime;
        if (elapsedMs > this.maxRunMs) {
          this.logger.warn("Reconciliation job exceeded maxRunMs", {
            elapsedMs,
            maxRunMs: this.maxRunMs,
            marketsProcessed: results.length,
            marketsRemaining: markets.length - results.length,
          });
          break;
        }

        try {
          const result = await positionReconciliationService.reconcileMarket(
            market.id,
            this.autoRecoveryEnabled
          );

          results.push(result);

          this.logger.debug("Reconciliation completed for market", {
            marketId: market.id,
            totalWallets: result.totalWallets,
            driftCount: result.driftCount,
            recoveredCount: result.recoveredCount,
            duration: result.duration,
          });
        } catch (error) {
          failedMarkets++;
          this.logger.error("Failed to reconcile market", {
            marketId: market.id,
            error: (error as Error).message,
          });
        }
      }

      const totalDuration = performance.now() - startTime;

      const aggregateStats = {
        reconciledCount: results.reduce(
          (sum, r) => sum + r.totalWallets,
          0
        ),
        driftCount: results.reduce((sum, r) => sum + r.driftCount, 0),
        recoveredCount: results.reduce((sum, r) => sum + r.recoveredCount, 0),
      };

      this.logger.info("Reconciliation job completed", {
        marketCount: results.length,
        failedMarkets,
        totalWallets: aggregateStats.reconciledCount,
        driftDetected: aggregateStats.driftCount,
        recovered: aggregateStats.recoveredCount,
        duration: totalDuration,
      });

      return {
        success: failedMarkets === 0,
        totalMarkets: markets.length,
        completedMarkets: results.length,
        failedMarkets,
        aggregateStats,
        duration: totalDuration,
      };
    } catch (error) {
      this.logger.error("Reconciliation job failed", {
        error: (error as Error).message,
      });
      throw error;
    }
  }
}
