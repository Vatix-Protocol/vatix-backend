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
   * Returns count of records not yet published to downstream systems
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
      // Outbox table may not exist yet; gracefully degrade to 0
      console.debug("Outbox table not available or query failed:", error);
      return 0;
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
    const [settlementDepth, outboxCount] = await Promise.all([
      this.getSettlementQueueDepth(),
      this.getOutboxUnpublishedCount(),
    ]);

    const totalLag = this.computeTotalLag(settlementDepth, outboxCount);
    const shedding = this.updateShedState(totalLag);

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
