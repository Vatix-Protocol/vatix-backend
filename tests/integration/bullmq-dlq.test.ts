/**
 * Integration test (issue #953): the BullMQ dead-letter tooling must be able
 * to see and move poison jobs that exhausted their retries — the failure mode
 * being "poison jobs sit in the DLQ with no operator path besides redis-cli".
 *
 * Drives a real BullMQ queue + worker against Redis: a job that always throws
 * lands in the `failed` set, BullmqDlq lists it, retry-all puts it back for
 * another attempt, and discard removes it for good.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Queue, Worker, type Job } from "bullmq";
import {
  DEFAULT_JOB_OPTIONS,
  redisConnectionFromEnv,
} from "../../apps/workers/src/shared/queue-config.js";
import { BullmqDlq } from "../../apps/workers/src/consumers/bullmq-dlq.js";

const QUEUE_NAME = `vatix:test-dlq-${process.pid}`;

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor timed out");
}

describe("BullMQ DLQ tooling (#953)", () => {
  let queue: Queue;
  let worker: Worker;
  let attemptLog: string[] = [];

  beforeAll(async () => {
    queue = new Queue(QUEUE_NAME, {
      connection: redisConnectionFromEnv(),
      defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
    });
    worker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        attemptLog.push(String(job.id));
        throw new Error("poison job always fails");
      },
      { connection: redisConnectionFromEnv(), concurrency: 1 }
    );
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });

  beforeEach(async () => {
    attemptLog = [];
    await queue.drain(true);
    const failed = await queue.getFailed();
    await Promise.all(failed.map((j) => j.remove()));
  });

  it("lists a retry-exhausted job, retries it, then discards it", async () => {
    const job = await queue.add(
      "poison",
      { foo: "bar" },
      { jobId: "poison-1" }
    );
    await waitFor(async () => (await queue.getFailedCount()) === 1);

    const dlq = new BullmqDlq(queue as never);

    // list
    const entries = await dlq.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].jobId).toBe("poison-1");
    expect(entries[0].failedReason).toContain("poison job always fails");

    // retry-all → job leaves the failed set for another attempt
    attemptLog = [];
    const result = await dlq.retryAll();
    expect(result.retried).toEqual(["poison-1"]);
    await waitFor(async () => attemptLog.includes("poison-1"));
    await waitFor(async () => (await queue.getFailedCount()) === 1);

    // discard → gone for good
    await dlq.discard("poison-1");
    expect(await queue.getFailedCount()).toBe(0);
    expect(await queue.getJob("poison-1")).toBeFalsy();

    await job.remove().catch(() => undefined);
  });

  it("dry-run retry-all touches nothing", async () => {
    await queue.add("poison", { n: 1 }, { jobId: "poison-2" });
    await waitFor(async () => (await queue.getFailedCount()) === 1);

    const dlq = new BullmqDlq(queue as never);
    attemptLog = [];
    const result = await dlq.retryAll({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.retried).toEqual(["poison-2"]);
    expect(await queue.getFailedCount()).toBe(1);
    expect(attemptLog).toHaveLength(0);
  });
});
