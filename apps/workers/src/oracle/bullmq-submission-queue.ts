/**
 * BullMQ Oracle Submission Queue — ADR 001 (#452)
 *
 * Replaces RedisSubmissionQueue (raw Redis Streams) with a BullMQ Queue +
 * Worker pair. Deduplication is preserved via a jobId derived from the
 * market ID + payload hash — BullMQ deduplicates by job ID automatically.
 *
 * @module apps/workers/src/oracle/bullmq-submission-queue
 */
import { createHash } from "crypto";
import { Queue, Worker, type Job } from "bullmq";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import type { SubmissionQueueItem } from "../../../oracle/submission-queue.js";
import {
  DEFAULT_JOB_OPTIONS,
  redisConnectionFromEnv,
} from "../shared/queue-config.js";

const QUEUE_NAME = process.env.SUBMISSION_QUEUE_NAME ?? "oracle-submissions";

function payloadHash(item: SubmissionQueueItem): string {
  return createHash("sha256")
    .update(JSON.stringify(item.result))
    .digest("hex")
    .slice(0, 16);
}

/**
 * BullMQ-backed oracle submission queue producer.
 * Uses the market ID + payload hash as the BullMQ job ID for deduplication.
 */
export class BullMQSubmissionQueue {
  private queue: Queue<SubmissionQueueItem>;
  private logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger;
    this.queue = new Queue<SubmissionQueueItem>(QUEUE_NAME, {
      connection: redisConnectionFromEnv(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }

  /**
   * Enqueue an oracle submission.
   * Returns false if the job already exists (deduplication).
   */
  async enqueue(item: SubmissionQueueItem): Promise<boolean> {
    const jobId = `${item.request.marketId}:${payloadHash(item)}`;

    // BullMQ skips enqueue if a job with the same ID already exists.
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      this.logger.info("Oracle submission already queued, skipping", {
        jobId,
        marketId: item.request.marketId,
      });
      return false;
    }

    await this.queue.add(item.request.marketId, item, {
      ...DEFAULT_JOB_OPTIONS,
      jobId,
    });

    this.logger.info("Oracle submission enqueued", {
      jobId,
      marketId: item.request.marketId,
      enqueuedAt: item.enqueuedAt,
    });

    return true;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * Create a BullMQ Worker for oracle submissions.
 * The handler receives each SubmissionQueueItem and is responsible for
 * on-chain submission and DB persistence.
 */
export function createOracleSubmissionWorker(
  handler: (item: SubmissionQueueItem, attemptsMade: number) => Promise<void>,
  logger: ILogger
): Worker<SubmissionQueueItem> {
  const worker = new Worker<SubmissionQueueItem>(
    QUEUE_NAME,
    async (job: Job<SubmissionQueueItem>) => {
      await handler(job.data, job.attemptsMade);
    },
    {
      connection: redisConnectionFromEnv(),
      concurrency: 1,
    }
  );

  worker.on("completed", (job) => {
    logger.info("Oracle submission job completed", { jobId: job.id });
  });

  worker.on("failed", (job, err) => {
    logger.error("Oracle submission job failed", {
      jobId: job?.id,
      attempts: job?.attemptsMade,
      error: err.message,
    });
  });

  return worker;
}
