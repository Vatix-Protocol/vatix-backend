/**
 * Shared BullMQ job options for all queues (settlement + oracle submission).
 *
 * Unified retry / backoff / DLQ configuration — ADR 001.
 *
 * @module apps/workers/src/shared/queue-config
 */
import type { JobsOptions } from "bullmq";

/**
 * Default job options applied to every enqueued job unless overridden.
 *
 * - attempts:         3 retries before moving to DLQ
 * - backoff:          exponential, starting at 1 s (1 s, 2 s, 4 s …)
 * - removeOnComplete: keep the last 100 completed jobs for observability
 * - removeOnFail:     false — retain ALL failed jobs as DLQ so they can be
 *                     inspected and replayed without data loss
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: false,
};

/** Build a Redis connection config from the environment. */
export function redisConnectionFromEnv(): { url: string } {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return { url };
}
