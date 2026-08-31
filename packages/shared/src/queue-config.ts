/**
 * Shared BullMQ job options and queue-name helpers for all queues
 * (settlement + oracle submission).
 *
 * Unified retry / backoff / DLQ configuration — ADR 001.
 * Single source of truth for queue names — #779.
 *
 * @module packages/shared/src/queue-config
 */
import type { JobsOptions } from "bullmq";

/**
 * Job options for the settlement queue (on-chain trade settlement).
 *
 * - attempts:         3 retries before moving to DLQ
 * - backoff:          exponential, starting at 1 s (1 s, 2 s, 4 s …)
 * - removeOnComplete: keep the last 100 completed jobs for observability
 * - removeOnFail:     false — retain ALL failed jobs as DLQ so they can be
 *                     inspected and replayed without data loss
 */
export const SETTLEMENT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: false,
};

/**
 * Job options for the oracle submission queue (Stellar contract calls
 * that finalize market resolution). Oracle submissions are more transient
 * failure-prone (RPC rate limits, ledger congestion) than settlement, so
 * they get more attempts with a shorter initial backoff to keep resolution
 * latency low without hammering the RPC endpoint.
 *
 * - attempts:         8 retries before moving to DLQ
 * - backoff:          exponential, starting at 500 ms (500 ms, 1 s, 2 s …)
 * - removeOnComplete: keep the last 100 completed jobs for observability
 * - removeOnFail:     false — retain ALL failed jobs as DLQ so they can be
 *                     inspected and replayed without data loss
 */
export const ORACLE_SUBMISSION_JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: "exponential", delay: 500 },
  removeOnComplete: { count: 100 },
  removeOnFail: false,
};

/**
 * @deprecated Use {@link SETTLEMENT_JOB_OPTIONS} or
 * {@link ORACLE_SUBMISSION_JOB_OPTIONS} explicitly. Kept as an alias to
 * SETTLEMENT_JOB_OPTIONS for backward compatibility with existing callers;
 * do not add new usages of this export since a single shared default is
 * exactly the bug this module fixes (#issue: queue-config backoff split).
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = SETTLEMENT_JOB_OPTIONS;

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

/**
 * Build a Redis connection config from the environment.
 *
 * In production, falling back to localhost when REDIS_URL is unset is a
 * silent misconfiguration: the queue would connect to a Redis instance that
 * almost certainly isn't the production broker, and jobs (settlement,
 * oracle submissions) would appear to enqueue successfully while never
 * reaching a worker that processes real trades. Fail fast instead so the
 * process crashes at startup rather than silently dropping production
 * trades/resolutions.
 */
export function redisConnectionFromEnv(): {
  host: string;
  port: number;
  password?: string;
} {
  if (!process.env.REDIS_URL && process.env.NODE_ENV === "production") {
    throw new Error(
      "REDIS_URL is required in production (NODE_ENV=production) — refusing to fall back to localhost:6379 for queue connections"
    );
  }

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
