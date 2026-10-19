import { Queue } from "bullmq";
import { redis } from "./redis.js";
import { getPrismaClient } from "./prisma.js";
import {
  redisConnectionFromEnv,
  settlementQueueName,
  DEFAULT_JOB_OPTIONS,
} from "../../apps/workers/src/shared/queue-config.js";

export interface LagMetrics {
  settlementQueueDepth: number;
  outboxUnpublishedCount: number;
  totalLag: number;
  shedding: boolean;
  timestamp: number;
}

export interface LagConfig {
  highWaterMark: number;
  lowWaterMark: number;
}

// Prisma error codes indicating the outbox table/model does not exist yet.
const MISSING_TABLE_CODES = new Set(["P2021", "P2022"]);

// Sentinel used when the outbox read fails for a non-missing-table reason.
const OUTBOX_UNAVAILABLE_SENTINEL = -1;

export class LagDetector {
  private shedState: boolean = false;
  private readonly config: LagConfig;
  private lastMetrics: LagMetrics | null = null;
  private settlementQueue: Queue;

  constructor(config: LagConfig) {
    this.config = config;
    this.settlementQueue = new Queue(settlementQueueName(), {
      connection: redisConnectionFromEnv(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }

  /**
   * Read settlement queue depth from BullMQ
   * Returns sum of jobs in wait, delayed, and active states
   */
  async getSettlementQueueDepth(): Promise<number> {
    try {
      const [waitCount, delayedCount, activeCount] = await Promise.all([
        this.settlementQueue.getWaitingCount(),
        this.settlementQueue.getDelayedCount(),
        this.settlementQueue.getActiveCount(),
      ]);

      const totalDepth = waitCount + delayedCount + activeCount;
      return Math.max(0, totalDepth);
    } catch (error) {
      console.error("Failed to read settlement queue depth:", error);
      throw error;
    }
  }

  /**
   * Read outbox unpublished count (pending transactional outbox entries)
   * Returns count of records not yet published to downstream systems.
   *
   * Only a missing-table error (Prisma P2021/P2022) degrades to 0. Any other
   * error is logged at warn level and rethrown so callers can fail closed.
   */
  async getOutboxUnpublishedCount(): Promise<number> {
    try {
      const prisma = getPrismaClient();

      // Query outbox table for unpublished entries
      // Assumes outbox model exists with published_at field
      const count = await prisma.outboxEvent.count({
        where: {
          publishedAt: null,
        },
      });

      return Math.max(0, count);
    } catch (error) {
      const code = (error as { code?: string }).code;

      if (code && MISSING_TABLE_CODES.has(code)) {
        // Outbox table may not exist yet; gracefully degrade to 0
        console.debug("Outbox table not available, degrading to 0", { code });
        return 0;
      }

      // Genuine failure (transient outage, permissions, etc.) must not be
      // masked as zero lag. Log the code only, never the connection string.
      console.warn("Failed to read outbox unpublished count", { code });
      throw error;
    }
  }

  /**
   * Compute total lag as weighted sum of queue depth and outbox
   */
  private computeTotalLag(depth: number, outbox: number): number {
    // Weight settlement queue more heavily since it directly affects trade processing
    const weightedDepth = depth * 1.0;
    const weightedOutbox = outbox * 0.5;
    return Math.round(weightedDepth + weightedOutbox);
  }

  /**
   * Update shedding state based on current metrics
   * Implements hysteresis: shed at high threshold, recover at low threshold
   */
  private updateShedState(totalLag: number): boolean {
    if (!this.shedState && totalLag >= this.config.highWaterMark) {
      // Transition to shedding
      this.shedState = true;
      console.warn("Lag threshold exceeded, entering shedding state", {
        lag: totalLag,
        threshold: this.config.highWaterMark,
      });
    } else if (this.shedState && totalLag <= this.config.lowWaterMark) {
      // Transition from shedding
      this.shedState = false;
      console.info(
        "Lag recovered below low water mark, exiting shedding state",
        {
          lag: totalLag,
          lowWater: this.config.lowWaterMark,
        }
      );
    }

    return this.shedState;
  }

  /**
   * Get current lag metrics
   */
  async getMetrics(): Promise<LagMetrics> {
    const [settlementDepth, outboxResult] = await Promise.all([
      this.getSettlementQueueDepth(),
      this.getOutboxUnpublishedCount().then(
        (count) => ({ ok: true as const, count }),
        () => ({ ok: false as const })
      ),
    ]);

    const outboxUnavailable = !outboxResult.ok;
    const outboxCount = outboxResult.ok
      ? outboxResult.count
      : OUTBOX_UNAVAILABLE_SENTINEL;

    const totalLag = this.computeTotalLag(settlementDepth, outboxCount);

    // Fail closed: if the outbox is unavailable, force shedding regardless of
    // the computed total lag.
    const shedding = outboxUnavailable
      ? this.forceShed()
      : this.updateShedState(totalLag);

    const metrics: LagMetrics = {
      settlementQueueDepth: settlementDepth,
      outboxUnpublishedCount: outboxCount,
      totalLag,
      shedding,
      timestamp: Date.now(),
    };

    this.lastMetrics = metrics;
    return metrics;
  }

  /**
   * Force shedding on (fail closed) when the outbox is unavailable.
   */
  private forceShed(): boolean {
    if (!this.shedState) {
      this.shedState = true;
      console.warn(
        "Outbox unavailable, forcing shedding state (fail closed)"
      );
    }
    return this.shedState;
  }

  /**
   * Check if we should shed traffic
   */
  async shouldShed(): Promise<boolean> {
    const metrics = await this.getMetrics();
    return metrics.shedding;
  }

  /**
   * Get last cached metrics (for frequent checks without querying)
   */
  getLastMetrics(): LagMetrics | null {
    return this.lastMetrics;
  }

  /**
   * Reset shedding state (for manual intervention)
   */
  resetShedState(): void {
    this.shedState = false;
    console.info("Shedding state reset manually");
  }
}

export const lagDetector = new LagDetector({
  highWaterMark: parseInt(
    process.env.SETTLEMENT_LAG_SHED_THRESHOLD ?? "1000",
    10
  ),
  lowWaterMark: parseInt(
    process.env.SETTLEMENT_LAG_RECOVERY_THRESHOLD ?? "500",
    10
  ),
});
