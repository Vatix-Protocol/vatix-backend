/**
 * BullMQ dead-letter (failed-job) operator tooling — issue #953.
 *
 * The settlement (`settlement-trades`) and oracle (`oracle-submissions`)
 * queues run with `removeOnFail: false` (queue-config.ts), so a job that
 * exhausts its retries stays in BullMQ's `failed` set forever. That set *is*
 * the DLQ, but until now the only way to see or move those jobs was
 * `redis-cli` against BullMQ's internal keys. This module gives operators a
 * safe, typed path: list, retry (one or many), and discard.
 *
 * `scripts/replay-dlq.ts` handles the *other*, older DLQ — the raw
 * `vatix:dead-letter:*` Redis streams written by `logDeadLetter()` for
 * non-retryable poison messages. The two are independent.
 */
import { Queue, type Job } from "bullmq";
import {
  redisConnectionFromEnv,
  settlementQueueName,
  submissionQueueName,
} from "../../../../packages/shared/src/queue-config.js";

export type DlqQueue = "settlement" | "oracle";

export const DLQ_QUEUES: readonly DlqQueue[] = [
  "settlement",
  "oracle",
] as const;

export function isDlqQueue(value: string): value is DlqQueue {
  return (DLQ_QUEUES as readonly string[]).includes(value);
}

/** Resolve the operator-facing queue alias to its real BullMQ queue name. */
export function resolveDlqQueueName(queue: DlqQueue): string {
  switch (queue) {
    case "settlement":
      return settlementQueueName();
    case "oracle":
      return submissionQueueName();
  }
}

export class DlqJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`No job ${jobId} in this queue`);
    this.name = "DlqJobNotFoundError";
  }
}

export class DlqJobNotFailedError extends Error {
  constructor(jobId: string, state: string) {
    super(
      `Job ${jobId} is "${state}", not "failed" — refusing to act on a job that is not dead-lettered`
    );
    this.name = "DlqJobNotFailedError";
  }
}

export interface DlqEntry {
  jobId: string;
  name: string;
  attemptsMade: number;
  failedReason: string;
  /** ms epoch the job was created. */
  timestamp: number;
  data: unknown;
}

export interface DlqRetryResult {
  scanned: number;
  retried: string[];
  failed: Array<{ jobId: string; error: string }>;
  dryRun: boolean;
}

/** Minimal slice of a BullMQ Job the DLQ helper touches (keeps tests light). */
export interface DlqJobLike {
  id?: string | null;
  name: string;
  data: unknown;
  attemptsMade: number;
  failedReason?: string;
  timestamp: number;
  getState(): Promise<string>;
  retry(state?: "failed" | "completed"): Promise<void>;
  remove(): Promise<unknown>;
}

/** Minimal slice of a BullMQ Queue the DLQ helper touches. */
export interface DlqQueueLike {
  getFailedCount(): Promise<number>;
  getFailed(start?: number, end?: number): Promise<DlqJobLike[]>;
  getJob(jobId: string): Promise<DlqJobLike | undefined | null>;
  close(): Promise<void>;
}

function toEntry(job: DlqJobLike): DlqEntry {
  return {
    jobId: String(job.id ?? job.name),
    name: job.name,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason ?? "",
    timestamp: job.timestamp,
    data: job.data,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const DEFAULT_LIMIT = 100;

export class BullmqDlq {
  constructor(private readonly queue: DlqQueueLike) {}

  /** Open a live DLQ handle for one of the known queues. Caller must close(). */
  static forQueue(queue: DlqQueue): BullmqDlq {
    const q = new Queue(resolveDlqQueueName(queue), {
      connection: redisConnectionFromEnv(),
    }) as unknown as DlqQueueLike;
    return new BullmqDlq(q);
  }

  async stats(): Promise<{ failed: number }> {
    return { failed: await this.queue.getFailedCount() };
  }

  async list(opts: { limit?: number } = {}): Promise<DlqEntry[]> {
    const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
    const jobs = await this.queue.getFailed(0, limit - 1);
    return jobs.map(toEntry);
  }

  private async requireFailedJob(jobId: string): Promise<DlqJobLike> {
    const job = await this.queue.getJob(jobId);
    if (!job) throw new DlqJobNotFoundError(jobId);
    const state = await job.getState();
    if (state !== "failed") throw new DlqJobNotFailedError(jobId, state);
    return job;
  }

  /** Re-queue one dead-lettered job through the normal worker path. */
  async retry(jobId: string): Promise<void> {
    const job = await this.requireFailedJob(jobId);
    await job.retry("failed");
  }

  /** Permanently drop one dead-lettered job. */
  async discard(jobId: string): Promise<void> {
    const job = await this.requireFailedJob(jobId);
    await job.remove();
  }

  /**
   * Retry up to `limit` dead-lettered jobs. `dryRun` reports what would be
   * retried without touching anything. Per-job failures are collected, not
   * thrown, so one un-retryable job never blocks the rest of the batch.
   */
  async retryAll(
    opts: { limit?: number; dryRun?: boolean } = {}
  ): Promise<DlqRetryResult> {
    const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
    const dryRun = opts.dryRun ?? false;
    const jobs = await this.queue.getFailed(0, limit - 1);

    const result: DlqRetryResult = {
      scanned: jobs.length,
      retried: [],
      failed: [],
      dryRun,
    };

    for (const job of jobs) {
      const id = String(job.id ?? job.name);
      if (dryRun) {
        result.retried.push(id);
        continue;
      }
      try {
        await job.retry("failed");
        result.retried.push(id);
      } catch (e) {
        result.failed.push({ jobId: id, error: errMsg(e) });
      }
    }

    return result;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export type { Job };
