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
export function redisConnectionFromEnv(): { host: string; port: number; password?: string } {
  const raw = process.env.REDIS_URL ?? "redis://localhost:6379";
  // Strip scheme, split auth@hostport
  const noScheme = raw.replace(/^rediss?:\/\//, "");
  const atIdx = noScheme.lastIndexOf("@");
  const hostPort = atIdx >= 0 ? noScheme.slice(atIdx + 1) : noScheme;
  const authPart = atIdx >= 0 ? noScheme.slice(0, atIdx) : "";
  const [host, portStr] = hostPort.split(":");
  const password = authPart.includes(":") ? authPart.split(":")[1] : authPart || undefined;
  return {
    host: host || "localhost",
    port: Number(portStr) || 6379,
    ...(password ? { password } : {}),
  };
}
