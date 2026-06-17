import { redis } from "./redis.js";
import type { Outcome } from "../types/index.js";

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
  private streamKey: string;

  constructor() {
    const queueName = process.env.SETTLEMENT_QUEUE_NAME ?? "settlement-trades";
    const keyPrefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
    this.streamKey = `${keyPrefix}${queueName}`;
  }

  async enqueue(job: SettlementJob): Promise<void> {
    const fields = [
      "tradeId",
      job.tradeId,
      "marketId",
      job.marketId,
      "outcome",
      job.outcome,
      "buyOrderId",
      job.buyOrderId,
      "sellOrderId",
      job.sellOrderId,
      "buyerAddress",
      job.buyerAddress,
      "sellerAddress",
      job.sellerAddress,
      "price",
      job.price.toString(),
      "quantity",
      job.quantity.toString(),
      "timestamp",
      job.timestamp.toString(),
    ];

    await redis.xadd(this.streamKey, "*", ...fields);
  }
}

export const settlementQueue = new SettlementQueueProducer();
