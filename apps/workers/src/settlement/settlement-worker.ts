import type { ILogger } from "../../../../packages/shared/src/logger.js";
import {
  processJob,
  type QueueJob,
  type QueueConsumerConfig,
} from "../consumers/queue-consumer.js";
import { logDeadLetter } from "../consumers/dead-letter.js";

export interface SettlementJobPayload {
  tradeId: string;
  marketId: string;
  outcome: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerAddress: string;
  sellerAddress: string;
  price: string;
  quantity: string;
  timestamp: string;
}

export interface SettlementWorkerConfig {
  maxAttempts: number;
  processingTimeoutMs: number;
  idempotencyTtlSeconds: number;
}

export interface SettlementRedisClient {
  exists: (key: string) => Promise<boolean | number>;
  set: (key: string, value: string, ttl?: number) => Promise<void>;
}

export class SettlementWorker {
  private readonly consumerConfig: QueueConsumerConfig;
  private readonly idempotencyTtlSeconds: number;
  private readonly logger: ILogger;
  private readonly redisClient: SettlementRedisClient;

  constructor(
    redisClient: SettlementRedisClient,
    logger: ILogger,
    config: SettlementWorkerConfig
  ) {
    this.redisClient = redisClient;
    this.logger = logger;
    this.idempotencyTtlSeconds = config.idempotencyTtlSeconds;
    this.consumerConfig = {
      queueName: "settlement",
      maxAttempts: config.maxAttempts,
      processingTimeoutMs: config.processingTimeoutMs,
    };
  }

  async process(job: QueueJob): Promise<void> {
    try {
      await processJob(this.logger, this.consumerConfig, job, (j) =>
        this.handleJob(j)
      );
    } catch (error) {
      if (job.attempts >= this.consumerConfig.maxAttempts) {
        logDeadLetter(this.logger, {
          id: job.id,
          queue: this.consumerConfig.queueName,
          payload: job.payload,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private async handleJob(job: QueueJob): Promise<void> {
    const payload = job.payload as SettlementJobPayload;
    const { tradeId } = payload;

    const idempotencyKey = `settlement:processed:${tradeId}`;
    const alreadyProcessed = await this.redisClient.exists(idempotencyKey);

    if (alreadyProcessed) {
      this.logger.info("Settlement job skipped (already processed)", {
        tradeId,
        jobId: job.id,
      });
      return;
    }

    this.logger.info("Processing settlement job", {
      tradeId,
      marketId: payload.marketId,
      buyOrderId: payload.buyOrderId,
      sellOrderId: payload.sellOrderId,
      price: payload.price,
      quantity: payload.quantity,
    });

    // TODO: Implement actual on-chain settlement execution

    await this.redisClient.set(idempotencyKey, "1", this.idempotencyTtlSeconds);

    this.logger.info("Settlement job completed", {
      tradeId,
      marketId: payload.marketId,
    });
  }
}
