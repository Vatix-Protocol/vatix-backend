/**
 * Redis-Backed Oracle Submission Queue
 *
 * Provides durable queue semantics for oracle submissions using Redis streams.
 * Implements at-least-once delivery with visibility timeout and idempotency.
 *
 * @module apps/workers/src/oracle/redis-submission-queue
 */

import { createHash } from "crypto";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import type { SubmissionQueueItem } from "../../../oracle/submission-queue.js";

const STREAM_KEY = "oracle:submissions";
const CONSUMER_GROUP = "oracle-worker";

export interface RedisSubmissionQueueConfig {
  redisClient: any;
  visibilityTimeoutMs: number;
  deduplicationTtlSeconds?: number;
  logger: ILogger;
}

export interface QueuedSubmission extends SubmissionQueueItem {
  streamId: string;
  visibilityExpiresAt: number;
}

/**
 * Redis-backed submission queue using streams with consumer groups.
 */
export class RedisSubmissionQueue {
  private redisClient: any;
  private visibilityTimeoutMs: number;
  private deduplicationTtlSeconds: number;
  private logger: ILogger;

  constructor(config: RedisSubmissionQueueConfig) {
    this.redisClient = config.redisClient;
    this.visibilityTimeoutMs = config.visibilityTimeoutMs;
    this.deduplicationTtlSeconds = config.deduplicationTtlSeconds ?? 86400;
    this.logger = config.logger;
  }

  /**
   * Initialize the consumer group (idempotent).
   */
  async initialize(): Promise<void> {
    try {
      await this.redisClient.xgroup("CREATE", STREAM_KEY, CONSUMER_GROUP, "$", {
        MKSTREAM: true,
      });
      this.logger.info("Oracle submission queue initialized", {
        stream: STREAM_KEY,
        group: CONSUMER_GROUP,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("BUSYGROUP")) {
        this.logger.info("Consumer group already exists", {
          stream: STREAM_KEY,
          group: CONSUMER_GROUP,
        });
      } else {
        throw error;
      }
    }
  }

  /**
   * Compute SHA256 hash of the payload.
   */
  private computePayloadHash(payload: unknown): string {
    const normalized = JSON.stringify(payload);
    return createHash("sha256").update(normalized).digest("hex");
  }

  /**
   * Check if a submission is already queued (deduplication).
   */
  private async isAlreadyQueued(
    marketId: string,
    payloadHash: string
  ): Promise<boolean> {
    const dedupKey = `oracle:dedup:${marketId}:${payloadHash}`;
    return (await this.redisClient.exists(dedupKey)) > 0;
  }

  /**
   * Mark a submission as queued (set dedup flag with TTL).
   */
  private async markAsQueued(
    marketId: string,
    payloadHash: string,
    streamId: string
  ): Promise<void> {
    const dedupKey = `oracle:dedup:${marketId}:${payloadHash}`;
    await this.redisClient.set(
      dedupKey,
      streamId,
      "EX",
      this.deduplicationTtlSeconds
    );
  }

  /**
   * Enqueue a submission to the Redis stream.
   * Returns false if already queued (deduplication).
   */
  async enqueue(item: SubmissionQueueItem): Promise<boolean> {
    const payloadHash = this.computePayloadHash(item.result);
    const marketId = item.request.marketId;

    const alreadyQueued = await this.isAlreadyQueued(marketId, payloadHash);
    if (alreadyQueued) {
      this.logger.info("Submission already queued, skipping duplicate", {
        marketId,
        payloadHash: payloadHash.substring(0, 8),
        id: item.id,
      });
      return false;
    }

    const streamId = await this.redisClient.xadd(
      STREAM_KEY,
      "*",
      "payload",
      JSON.stringify(item),
      "marketId",
      marketId,
      "payloadHash",
      payloadHash
    );

    await this.markAsQueued(marketId, payloadHash, streamId);

    this.logger.info("Oracle submission queued", {
      id: item.id,
      marketId,
      payloadHash: payloadHash.substring(0, 8),
      streamId,
      enqueuedAt: item.enqueuedAt,
    });

    return true;
  }

  /**
   * Dequeue a submission from the Redis stream (consumer group).
   * Sets visibility timeout for at-least-once delivery.
   */
  async dequeue(
    consumerName: string,
    maxWaitMs: number = 1000
  ): Promise<QueuedSubmission | null> {
    const messages = await this.redisClient.xreadgroup(
      CONSUMER_GROUP,
      consumerName,
      STREAM_KEY,
      ">",
      { COUNT: 1, BLOCK: maxWaitMs }
    );

    if (!messages || !messages.length) {
      return null;
    }

    const [, msgList] = messages[0];
    if (!msgList || !msgList.length) {
      return null;
    }

    const [streamId, fieldsData] = msgList[0];
    // fieldsData is either an object (newer ioredis) or array of [key, val, key, val, ...]
    const fields =
      typeof fieldsData === "object" && !Array.isArray(fieldsData)
        ? fieldsData
        : Object.fromEntries(
            Array.isArray(fieldsData)
              ? (fieldsData as string[]).reduce((acc: any[], val, i) => {
                  if (i % 2 === 0) acc.push([val]);
                  else acc[acc.length - 1].push(val);
                  return acc;
                }, [])
              : []
          );

    const payload = JSON.parse(fields.payload as string);

    const queued: QueuedSubmission = {
      ...payload,
      streamId,
      visibilityExpiresAt: Date.now() + this.visibilityTimeoutMs,
    };

    this.logger.info("Dequeued submission from Redis stream", {
      id: queued.id,
      marketId: queued.request.marketId,
      streamId,
      consumer: consumerName,
    });

    return queued;
  }

  /**
   * Acknowledge successful processing (remove from consumer group).
   */
  async acknowledge(submission: QueuedSubmission): Promise<void> {
    await this.redisClient.xack(
      STREAM_KEY,
      CONSUMER_GROUP,
      submission.streamId
    );

    this.logger.info("Acknowledged oracle submission", {
      id: submission.id,
      marketId: submission.request.marketId,
      streamId: submission.streamId,
    });
  }

  /**
   * Negative acknowledge (nack) — makes the message visible again for retry.
   */
  async nack(
    submission: QueuedSubmission,
    consumerName: string
  ): Promise<void> {
    await this.redisClient.xclaim(
      STREAM_KEY,
      CONSUMER_GROUP,
      consumerName,
      0, // Min idle time 0 = claim immediately
      submission.streamId
    );

    this.logger.warn("Nacked oracle submission for retry", {
      id: submission.id,
      marketId: submission.request.marketId,
      streamId: submission.streamId,
      attempts: submission.attempts,
      consumerName,
    });
  }
}
