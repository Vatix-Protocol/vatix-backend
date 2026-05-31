/**
 * Queue Consumer
 *
 * Generic queue consumer that processes jobs from a named queue.
 * All log messages use structured fields and appropriate log levels
 * so they integrate cleanly with the project's JSON logging pipeline.
 *
 * @module apps/workers/src/consumers/queue-consumer
 */

import type { Logger } from "../../../indexer/src/logger.js";

/** Shape of a single job pulled from the queue. */
export interface QueueJob {
  /** Unique job identifier. */
  id: string;
  /** Job payload. */
  payload: Record<string, unknown>;
  /** Number of delivery attempts (starts at 1). */
  attempts: number;
}

/** Configuration for the queue consumer. */
export interface QueueConsumerConfig {
  /** Logical queue name (e.g. "settlement", "finalization"). */
  queueName: string;
  /** Maximum number of processing attempts before dead-lettering. */
  maxAttempts: number;
  /** Processing timeout per job in milliseconds. */
  processingTimeoutMs: number;
}

/** Handler function invoked for each job. */
export type JobHandler = (job: QueueJob) => Promise<void>;

/**
 * Processes a single job from the queue with full structured logging.
 *
 * Log levels used:
 *   - `info`  — job received, job completed
 *   - `warn`  — retryable failure (attempts remaining)
 *   - `error` — terminal failure (max attempts exceeded)
 */
export async function processJob(
  logger: Logger,
  config: QueueConsumerConfig,
  job: QueueJob,
  handler: JobHandler,
): Promise<void> {
  logger.info("Job received from queue", {
    jobId: job.id,
    queue: config.queueName,
    attempt: job.attempts,
    maxAttempts: config.maxAttempts,
    timestamp: new Date().toISOString(),
  });

  const start = Date.now();

  try {
    await handler(job);

    const durationMs = Date.now() - start;
    logger.info("Job processed successfully", {
      jobId: job.id,
      queue: config.queueName,
      attempt: job.attempts,
      durationMs,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const durationMs = Date.now() - start;
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    if (job.attempts < config.maxAttempts) {
      logger.warn("Job processing failed, will retry", {
        jobId: job.id,
        queue: config.queueName,
        attempt: job.attempts,
        maxAttempts: config.maxAttempts,
        durationMs,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });
    } else {
      logger.error("Job processing failed, max attempts exceeded", {
        jobId: job.id,
        queue: config.queueName,
        attempt: job.attempts,
        maxAttempts: config.maxAttempts,
        durationMs,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });
    }

    throw error;
  }
}
