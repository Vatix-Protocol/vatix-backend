/**
 * Shared BullMQ job options and queue-name helpers for all queues
 * (settlement + oracle submission).
 *
 * Unified retry / backoff / DLQ configuration — ADR 001.
 * Single source of truth for queue names — #779.
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

/**
 * Returns the fully-qualified BullMQ queue name for the settlement worker.
 *
 * Format: `${REDIS_KEY_PREFIX}${SETTLEMENT_QUEUE_NAME}`
 *
 * Evaluated at call-time so tests can override env vars without module-cache
 * complications.
 */
export function settlementQueueName(): string {
  const name = process.env.SETTLEMENT_QUEUE_NAME ?? "settlement-trades";
  const prefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
  return `${prefix}${name}`;
}

/**
 * Returns the BullMQ queue name for the oracle submission worker.
 *
 * The oracle submission queue intentionally omits the key prefix because the
 * BullMQ Worker is scoped to the oracle service and does not share a Redis
 * keyspace with the settlement worker.
 *
 * Evaluated at call-time so tests can override env vars without module-cache
 * complications.
 */
export function submissionQueueName(): string {
  return process.env.SUBMISSION_QUEUE_NAME ?? "oracle-submissions";
}

/** Build a Redis connection config from the environment. */
export function redisConnectionFromEnv(): {
  host: string;
  port: number;
  password?: string;
} {
  const raw = process.env.REDIS_URL ?? "redis://localhost:6379";
  // Strip scheme, split auth@hostport
  const noScheme = raw.replace(/^rediss?:\/\//, "");
  const atIdx = noScheme.lastIndexOf("@");
  const hostPort = atIdx >= 0 ? noScheme.slice(atIdx + 1) : noScheme;
  const authPart = atIdx >= 0 ? noScheme.slice(0, atIdx) : "";
  const [host, portStr] = hostPort.split(":");
  const password = authPart.includes(":")
    ? authPart.split(":")[1]
    : authPart || undefined;
  return {
    host: host || "localhost",
    port: Number(portStr) || 6379,
    ...(password ? { password } : {}),
  };
}
