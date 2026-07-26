/**
 * Queue Consumer
 *
 * Generic queue consumer that processes jobs from a named queue.
 * All log messages use structured fields and appropriate log levels
 * so they integrate cleanly with the project's JSON logging pipeline.
 *
 * @module apps/workers/src/consumers/queue-consumer
 */

import type { ILogger } from "../../../../packages/shared/src/logger.js";

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
 * Error thrown when a job handler exceeds its configured processing timeout.
 * Treated as a retryable failure by the consumer pipeline.
 */
export class JobTimeoutError extends Error {
  readonly jobId: string;
  readonly timeoutMs: number;

  constructor(jobId: string, timeoutMs: number) {
    super(
      `Job ${jobId} timed out after ${timeoutMs}ms — processing limit exceeded`
    );
    this.name = "JobTimeoutError";
    this.jobId = jobId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Processes a single job from the queue with full structured logging and
 * enforced processing timeout.
 *
 * If the handler does not resolve within `config.processingTimeoutMs` the
 * promise is rejected with a `JobTimeoutError`. The job is then subject to
 * the normal retry/dead-letter logic.
 *
 * Log levels used:
 *   - `info`  — job received, job completed
 *   - `warn`  — retryable failure (attempts remaining) or timeout
 *   - `error` — terminal failure (max attempts exceeded)
 */
export async function processJob(
  logger: ILogger,
  config: QueueConsumerConfig,
  job: QueueJob,
  handler: JobHandler
): Promise<void> {
  logger.info("Job received from queue", {
    jobId: job.id,
    queue: config.queueName,
    attempt: job.attempts,
    maxAttempts: config.maxAttempts,
    timestamp: new Date().toISOString(),
  });

  const start = Date.now();

  // Race the handler against a per-job timeout so a hung handler cannot block
  // the worker indefinitely. The timeout promise always rejects so the
  // winner is whichever settles first.
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new JobTimeoutError(job.id, config.processingTimeoutMs));
    }, config.processingTimeoutMs);
  });

  try {
    await Promise.race([handler(job), timeoutPromise]);

    // Handler won the race — cancel the pending timeout.
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);

    const durationMs = Date.now() - start;
    logger.info("Job processed successfully", {
      jobId: job.id,
      queue: config.queueName,
      attempt: job.attempts,
      durationMs,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // Always clear the timeout on any outcome so we don't leak handles.
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);

    const durationMs = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const timedOut = error instanceof JobTimeoutError;

    if (timedOut) {
      logger.warn("Job processing timed out", {
        jobId: job.id,
        queue: config.queueName,
        attempt: job.attempts,
        maxAttempts: config.maxAttempts,
        processingTimeoutMs: config.processingTimeoutMs,
        durationMs,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });
    } else if (job.attempts < config.maxAttempts) {
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
