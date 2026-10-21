import { Queue, type Job } from "bullmq";
import { createRedisConnection } from "../redis.js";

/**
 * Typed, safe access to the BullMQ dead-letter queues.
 *
 * Operators previously had to poke at BullMQ's internal Redis keys with
 * `redis-cli` to inspect or replay failed jobs. This module is the supported
 * path: it resolves the concrete queue names, exposes a small typed surface
 * (`list`, `stats`, `retry`, `discard`, `retryAll`) and never leaks raw Redis
 * keys to callers.
 */

/** Default number of entries returned by `list()` when no limit is given. */
export const DEFAULT_LIMIT = 100;

/**
 * Hard upper bound on a single `list()` page. A caller asking for more is
 * clamped to this value so one call can never issue an unbounded
 * `getFailed` range request against Redis.
 */
export const MAX_LIMIT = 1000;

const DLQ_QUEUES = ["settlement", "oracle"] as const;
export type DlqQueueAlias = (typeof DLQ_QUEUES)[number];

/** Minimal shape of a BullMQ job that the DLQ surface relies on. */
export interface DlqJobLike {
  id?: string | null;
  name?: string;
  data?: unknown;
  attemptsMade?: number;
  failedReason?: string;
  timestamp?: number;
  getState(): Promise<string>;
  retry(state?: string): Promise<unknown>;
  remove(): Promise<unknown>;
}

/**
 * The subset of `Queue` used by `BullmqDlq`. Kept as a seam so tests can pass
 * lightweight doubles instead of a live Redis connection.
 */
export interface DlqQueueLike {
  getFailedCount(): Promise<number>;
  getFailed(start?: number, end?: number): Promise<DlqJobLike[]>;
  getJob(id: string): Promise<DlqJobLike | null | undefined>;
  close(): Promise<void>;
}

export interface DlqEntry {
  jobId: string;
  name: string;
  data: unknown;
  attemptsMade: number;
  failedReason: string;
  timestamp: number;
}

export interface DlqListOptions {
  /** Maximum entries to return. Clamped to `MAX_LIMIT`. Defaults to `DEFAULT_LIMIT`. */
  limit?: number;
  /** Zero-based offset into the failed set, for paging past the first page. */
  offset?: number;
}

export interface DlqRetryAllOptions {
  limit?: number;
  dryRun?: boolean;
}

export interface DlqRetryAllResult {
  scanned: number;
  retried: string[];
  failed: Array<{ jobId: string; error: string }>;
  dryRun: boolean;
}

export class DlqJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`DLQ job not found: ${jobId}`);
    this.name = "DlqJobNotFoundError";
  }
}

export class DlqJobNotFailedError extends Error {
  constructor(jobId: string) {
    super(`DLQ job is not in the failed state: ${jobId}`);
    this.name = "DlqJobNotFailedError";
  }
}

export function isDlqQueue(name: string): name is DlqQueueAlias {
  return (DLQ_QUEUES as readonly string[]).includes(name);
}

export function resolveDlqQueueName(alias: DlqQueueAlias): string {
  if (alias === "settlement") {
    const prefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
    const queue = process.env.SETTLEMENT_QUEUE_NAME ?? "settlement-trades";
    return `${prefix}${queue}`;
  }
  return process.env.SUBMISSION_QUEUE_NAME ?? "oracle-submissions";
}

function toEntry(job: DlqJobLike): DlqEntry {
  return {
    jobId: String(job.id),
    name: job.name ?? "",
    data: job.data,
    attemptsMade: job.attemptsMade ?? 0,
    failedReason: job.failedReason ?? "",
    timestamp: job.timestamp ?? 0,
  };
}

function clampLimit(limit: number | undefined): number {
  const requested = limit ?? DEFAULT_LIMIT;
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(requested), MAX_LIMIT);
}

function normaliseOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset <= 0) return 0;
  return Math.floor(offset);
}

export class BullmqDlq {
  constructor(private readonly queue: DlqQueueLike) {}

  static connect(alias: DlqQueueAlias): BullmqDlq {
    const queue = new Queue(resolveDlqQueueName(alias), {
      connection: createRedisConnection(),
    });
    return new BullmqDlq(queue as unknown as DlqQueueLike);
  }

  async stats(): Promise<{ failed: number }> {
    return { failed: await this.queue.getFailedCount() };
  }

  /**
   * List failed jobs, newest-first as BullMQ orders them, starting at `offset`.
   * `limit` is clamped to `MAX_LIMIT` so a single call cannot request an
   * unbounded range.
   */
  async list(opts: DlqListOptions = {}): Promise<DlqEntry[]> {
    const limit = clampLimit(opts.limit);
    const start = normaliseOffset(opts.offset);
    const end = start + limit - 1;
    const jobs = await this.queue.getFailed(start, end);
    return jobs.map(toEntry);
  }

  private async requireFailedJob(jobId: string): Promise<DlqJobLike> {
    const job = await this.queue.getJob(jobId);
    if (!job) throw new DlqJobNotFoundError(jobId);
    const state = await job.getState();
    if (state !== "failed") throw new DlqJobNotFailedError(jobId);
    return job;
  }

  async retry(jobId: string): Promise<void> {
    const job = await this.requireFailedJob(jobId);
    await job.retry("failed");
  }

  async discard(jobId: string): Promise<void> {
    const job = await this.requireFailedJob(jobId);
    await job.remove();
  }

  async retryAll(opts: DlqRetryAllOptions = {}): Promise<DlqRetryAllResult> {
    const limit = clampLimit(opts.limit);
    const jobs = await this.queue.getFailed(0, limit - 1);
    const dryRun = opts.dryRun ?? false;
    const retried: string[] = [];
    const failed: Array<{ jobId: string; error: string }> = [];

    for (const job of jobs) {
      const jobId = String(job.id);
      if (dryRun) {
        retried.push(jobId);
        continue;
      }
      try {
        await job.retry("failed");
        retried.push(jobId);
      } catch (err) {
        failed.push({
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { scanned: jobs.length, retried, failed, dryRun };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
