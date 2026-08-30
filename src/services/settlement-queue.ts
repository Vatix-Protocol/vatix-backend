import { Queue } from "bullmq";
import type { Outcome } from "../types/index.js";
import {
  DEFAULT_JOB_OPTIONS,
  redisConnectionFromEnv,
  settlementQueueName,
} from "../../packages/shared/src/queue-config.js";

export interface SettlementJob {
  tradeId: string;
  marketId: string;
  outcome: Outcome;
  buyOrderId: string;
  sellOrderId: string;
  buyerAddress: string;
  sellerAddress: string;
  price: number;
  quantity: number;
  timestamp: number;
}

class SettlementQueueProducer {
  private queue: Queue<SettlementJob>;

  constructor() {
    this.queue = new Queue<SettlementJob>(settlementQueueName(), {
      connection: redisConnectionFromEnv(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }

  async enqueue(job: SettlementJob): Promise<void> {
    const correlationId = `settlement:${job.tradeId}:${Date.now()}`;
    await this.queue.add(job.tradeId, job, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: `settlement:${job.tradeId}`,
    });
    console.log(
      JSON.stringify({
        level: "info",
        component: "settlement-queue",
        action: "settlement_enqueued",
        tradeId: job.tradeId,
        marketId: job.marketId,
        correlationId,
        timestamp: new Date().toISOString(),
      })
    );
  }
}

export const settlementQueue = new SettlementQueueProducer();
