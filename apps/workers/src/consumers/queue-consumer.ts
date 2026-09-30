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
import {
  queueJobProcessedTotal,
  queueJobDurationSeconds,
} from "../../../../src/services/metrics.js";

/** Shape of a single job pulled from the queue. */
export interface QueueJob {
  /** Unique job identifier. */
  id: string;
  /** Job payload. */
  payload: Record<string, unknown>;
  /** Number of delivery attempts (starts at 1). */
  attempts: number;
  /**
   * Optional producer-supplied correlation id (e.g. the API request id that
   * created the job). When present it is attached to every log line this
   * consumer emits, so a job can be traced from the originating request
   * through the queue to its terminal outcome.
   */
  correlationId?: string;
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

/**
 * Stable error codes raised by {@link assertValidConsumerConfig}.
 *
 * Part of the consumer's contract: boot-time config validators and operators can
 * branch on `error.code` instead of string-matching a human-readable message.
 */
export const QUEUE_CONSUMER_CONFIG_CODES = {
  /** `queueName` was not a short, control-character-free, non-empty string. */
  INVALID_QUEUE_NAME: "QUEUE_CONSUMER_INVALID_QUEUE_NAME",
  /** `maxAttempts` was not a finite integer `>= 1`. */
  INVALID_MAX_ATTEMPTS: "QUEUE_CONSUMER_INVALID_MAX_ATTEMPTS",
  /** `processingTimeoutMs` was not a finite number `>= 1`. */
  INVALID_PROCESSING_TIMEOUT: "QUEUE_CONSUMER_INVALID_PROCESSING_TIMEOUT",
  /** A delivered job reported a non-integer / non-positive `attempts`. */
  INVALID_JOB_ATTEMPTS: "QUEUE_CONSUMER_INVALID_JOB_ATTEMPTS",
} as const;

export type QueueConsumerConfigCode =
  (typeof QUEUE_CONSUMER_CONFIG_CODES)[keyof typeof QUEUE_CONSUMER_CONFIG_CODES];

/**
 * Raised when a consumer is handed a configuration that would make its
 * retry/timeout guarantees meaningless, or a job whose delivery counter cannot
 * be trusted.
 *
 * This is a *configuration* error, not a job failure: it is raised before the
 * handler runs and is never swallowed by the retry/dead-letter path.
 */
export class InvalidQueueConsumerConfigError extends Error {
  readonly code: QueueConsumerConfigCode;

  constructor(code: QueueConsumerConfigCode, message: string) {
    super(message);
    this.name = "InvalidQueueConsumerConfigError";
    this.code = code;
  }
}

/** Upper bound on an accepted queue name — key/log hygiene, not policy. */
const MAX_QUEUE_NAME_LENGTH = 128;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Validates a consumer configuration and fails closed.
 *
 * Every worker path funnels its retry budget and per-job deadline through
 * `processJob`, so an unvalidated config silently changes settlement behaviour:
 *
 * - `maxAttempts <= 0` (or `NaN`) makes `job.attempts < maxAttempts` false on
 *   the very first delivery, so every job is dead-lettered without ever being
 *   retried once.
 * - `processingTimeoutMs <= 0` (or `NaN`) makes `setTimeout` fire immediately,
 *   so every job "times out" before its handler can do any work; an unbounded
 *   value removes the deadline entirely and lets one hung handler wedge the
 *   worker.
 *
 * @throws {InvalidQueueConsumerConfigError} with a stable `code`.
 */
export function assertValidConsumerConfig(config: QueueConsumerConfig): void {
  const { queueName, maxAttempts, processingTimeoutMs } = config;

  if (
    typeof queueName !== "string" ||
    queueName.length === 0 ||
    queueName.length > MAX_QUEUE_NAME_LENGTH ||
    CONTROL_CHARACTERS.test(queueName)
  ) {
    throw new InvalidQueueConsumerConfigError(
      QUEUE_CONSUMER_CONFIG_CODES.INVALID_QUEUE_NAME,
      `queueName must be a non-empty string of at most ${MAX_QUEUE_NAME_LENGTH} characters containing no control characters`
    );
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new InvalidQueueConsumerConfigError(
      QUEUE_CONSUMER_CONFIG_CODES.INVALID_MAX_ATTEMPTS,
      `maxAttempts must be an integer >= 1, got: ${maxAttempts}`
    );
  }

  if (!Number.isFinite(processingTimeoutMs) || processingTimeoutMs < 1) {
    throw new InvalidQueueConsumerConfigError(
      QUEUE_CONSUMER_CONFIG_CODES.INVALID_PROCESSING_TIMEOUT,
      `processingTimeoutMs must be a finite number >= 1, got: ${processingTimeoutMs}`
    );
  }
}

/**
 * Validates a delivered job's attempt counter and fails closed.
 *
 * The counter drives the retry/dead-letter decision, so a job arriving with
 * `attempts: 0`, a negative number, or `NaN` (a malformed producer payload)
 * would satisfy `attempts < maxAttempts` forever — an unbounded poison-pill
 * loop that also blocks every job queued behind it. Refusing the delivery
 * instead lets the producer's bug surface as a terminal, attributable error
 * rather than as a worker that quietly never drains.
 *
 * @throws {InvalidQueueConsumerConfigError} when `attempts` is not a positive integer.
 */
export function assertValidJobAttempts(job: QueueJob): void {
  if (!Number.isInteger(job.attempts) || job.attempts < 1) {
    throw new InvalidQueueConsumerConfigError(
      QUEUE_CONSUMER_CONFIG_CODES.INVALID_JOB_ATTEMPTS,
      `Job ${job.id} has an invalid attempts counter: ${job.attempts} (expected an integer >= 1)`
    );
  }
}

/**
 * Handler function invoked for each job.
 *
 * The second argument is an `AbortSignal` that is aborted when
 * `config.processingTimeoutMs` elapses. Handlers doing cancellable work
 * (Stellar RPC calls, `fetch`) should thread it through, so a job already
 * declared timed-out stops consuming RPC quota instead of running to
 * completion in the background. Handlers that ignore it keep their previous
 * behaviour — the timeout still rejects `processJob`.
 */
export type JobHandler = (job: QueueJob, signal: AbortSignal) => Promise<void>;

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

/** Terminal outcomes reported by `processJob`, used as the `outcome` metric label. */
export const QUEUE_JOB_OUTCOMES = {
  SUCCESS: "success",
  /** Failed with attempts remaining — the queue will redeliver. */
  RETRY: "retry",
  /** Failed on the final attempt — the caller should dead-letter it. */
  EXHAUSTED: "exhausted",
  /** Exceeded `processingTimeoutMs`. */
  TIMEOUT: "timeout",
} as const;

export type QueueJobOutcome =
  (typeof QUEUE_JOB_OUTCOMES)[keyof typeof QUEUE_JOB_OUTCOMES];

/**
 * Processes a single job from the queue with full structured logging and
 * enforced processing timeout.
 *
 * If the handler does not resolve within `config.processingTimeoutMs` the
 * promise is rejected with a `JobTimeoutError`. The job is then subject to
 * the normal retry/dead-letter logic.
 *
 * The configuration and the job's attempt counter are validated first and
 * **fail closed**: an invalid config or an untrustworthy `attempts` value
 * throws `InvalidQueueConsumerConfigError` before the handler runs, because
 * either one silently disables the retry budget this function exists to
 * enforce.
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
  assertValidConsumerConfig(config);
  assertValidJobAttempts(job);

  // Correlation id: an explicit one from the producer is preferred so an
  // operator can stitch the queue log lines back to the API request that
  // enqueued the job; otherwise the job id is the only stable handle.
  const correlationId = job.correlationId ?? job.id;

  logger.info("Job received from queue", {
    jobId: job.id,
    queue: config.queueName,
    correlationId,
    attempt: job.attempts,
    maxAttempts: config.maxAttempts,
    timestamp: new Date().toISOString(),
  });

  const start = Date.now();

  // Race the handler against a per-job timeout so a hung handler cannot block
  // the worker indefinitely. The timeout promise always rejects so the
  // winner is whichever settles first. The controller additionally *signals*
  // the handler that it has been abandoned, rather than only giving up on it.
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const timeoutError = new JobTimeoutError(
        job.id,
        config.processingTimeoutMs
      );
      controller.abort(timeoutError);
      reject(timeoutError);
    }, config.processingTimeoutMs);
  });

  try {
    // Attach a no-op rejection handler to the handler promise *before* racing
    // it. If the timeout wins the race, the handler is abandoned mid-flight and
    // its eventual rejection would otherwise be an unhandled rejection, which
    // Node terminates the process on by default — one slow dependency would
    // crash-loop the whole worker instead of just failing one job.
    const handlerPromise = handler(job, controller.signal);
    handlerPromise.catch(() => {
      /* the race below already reported this outcome; swallow the orphan */
    });

    await Promise.race([handlerPromise, timeoutPromise]);

    // Handler won the race — cancel the pending timeout.
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);

    const durationMs = Date.now() - start;
    queueJobProcessedTotal
      .labels(config.queueName, QUEUE_JOB_OUTCOMES.SUCCESS)
      .inc();
    queueJobDurationSeconds
      .labels(config.queueName, QUEUE_JOB_OUTCOMES.SUCCESS)
      .observe(durationMs / 1000);
    logger.info("Job processed successfully", {
      jobId: job.id,
      queue: config.queueName,
      correlationId,
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
    // The retry decision uses `<` on a *validated* counter, so a job is retried
    // at most `maxAttempts - 1` times and the final failure is reported as
    // terminal for the caller to dead-letter.
    const willRetry = !timedOut && job.attempts < config.maxAttempts;
    const outcome: QueueJobOutcome = timedOut
      ? QUEUE_JOB_OUTCOMES.TIMEOUT
      : willRetry
        ? QUEUE_JOB_OUTCOMES.RETRY
        : QUEUE_JOB_OUTCOMES.EXHAUSTED;

    queueJobProcessedTotal.labels(config.queueName, outcome).inc();
    queueJobDurationSeconds
      .labels(config.queueName, outcome)
      .observe(durationMs / 1000);

    if (timedOut) {
      logger.warn("Job processing timed out", {
        jobId: job.id,
        queue: config.queueName,
        correlationId,
        attempt: job.attempts,
        maxAttempts: config.maxAttempts,
        processingTimeoutMs: config.processingTimeoutMs,
        durationMs,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });
    } else if (willRetry) {
      logger.warn("Job processing failed, will retry", {
        jobId: job.id,
        queue: config.queueName,
        correlationId,
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
        correlationId,
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
