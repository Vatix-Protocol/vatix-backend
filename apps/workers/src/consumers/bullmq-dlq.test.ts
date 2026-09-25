import { describe, it, expect, vi } from "vitest";
import {
  BullmqDlq,
  DlqJobNotFoundError,
  DlqJobNotFailedError,
  isDlqQueue,
  resolveDlqQueueName,
  type DlqJobLike,
  type DlqQueueLike,
} from "./bullmq-dlq.js";

function makeJob(overrides: Partial<DlqJobLike> = {}): DlqJobLike {
  return {
    id: "job-1",
    name: "trade-1",
    data: { tradeId: "trade-1" },
    attemptsMade: 3,
    failedReason: "boom",
    timestamp: Date.now() - 60_000,
    getState: vi.fn().mockResolvedValue("failed"),
    retry: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeQueue(jobs: DlqJobLike[]): DlqQueueLike {
  return {
    getFailedCount: vi.fn().mockResolvedValue(jobs.length),
    getFailed: vi
      .fn()
      .mockImplementation(async (start = 0, end = -1) =>
        end === -1 ? jobs.slice(start) : jobs.slice(start, end + 1)
      ),
    getJob: vi
      .fn()
      .mockImplementation(
        async (id: string) => jobs.find((j) => String(j.id) === id) ?? null
      ),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("queue alias resolution", () => {
  it("recognises the two known DLQ queues", () => {
    expect(isDlqQueue("settlement")).toBe(true);
    expect(isDlqQueue("oracle")).toBe(true);
    expect(isDlqQueue("nope")).toBe(false);
  });

  it("resolves aliases to concrete BullMQ queue names", () => {
    expect(resolveDlqQueueName("settlement")).toBe(
      process.env.SETTLEMENT_QUEUE_NAME
        ? `${process.env.REDIS_KEY_PREFIX ?? "vatix:"}${process.env.SETTLEMENT_QUEUE_NAME}`
        : "vatix:settlement-trades"
    );
    expect(resolveDlqQueueName("oracle")).toBe(
      process.env.SUBMISSION_QUEUE_NAME ?? "oracle-submissions"
    );
  });
});

describe("BullmqDlq", () => {
  it("stats reports the failed count", async () => {
    const dlq = new BullmqDlq(makeQueue([makeJob(), makeJob({ id: "job-2" })]));
    expect(await dlq.stats()).toEqual({ failed: 2 });
  });

  it("list maps failed jobs to entries and honours limit", async () => {
    const jobs = [
      makeJob({ id: "a" }),
      makeJob({ id: "b" }),
      makeJob({ id: "c" }),
    ];
    const dlq = new BullmqDlq(makeQueue(jobs));
    const entries = await dlq.list({ limit: 2 });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      jobId: "a",
      name: "trade-1",
      attemptsMade: 3,
      failedReason: "boom",
    });
  });

  it("retry re-queues a failed job", async () => {
    const job = makeJob();
    const dlq = new BullmqDlq(makeQueue([job]));
    await dlq.retry("job-1");
    expect(job.retry).toHaveBeenCalledWith("failed");
  });

  it("retry throws DlqJobNotFoundError for an unknown job", async () => {
    const dlq = new BullmqDlq(makeQueue([]));
    await expect(dlq.retry("ghost")).rejects.toBeInstanceOf(
      DlqJobNotFoundError
    );
  });

  it("retry refuses a job that is not in the failed state", async () => {
    const job = makeJob({ getState: vi.fn().mockResolvedValue("active") });
    const dlq = new BullmqDlq(makeQueue([job]));
    await expect(dlq.retry("job-1")).rejects.toBeInstanceOf(
      DlqJobNotFailedError
    );
    expect(job.retry).not.toHaveBeenCalled();
  });

  it("discard removes a failed job", async () => {
    const job = makeJob();
    const dlq = new BullmqDlq(makeQueue([job]));
    await dlq.discard("job-1");
    expect(job.remove).toHaveBeenCalledTimes(1);
  });

  it("retryAll dry-run reports without retrying", async () => {
    const jobs = [makeJob({ id: "a" }), makeJob({ id: "b" })];
    const dlq = new BullmqDlq(makeQueue(jobs));
    const result = await dlq.retryAll({ dryRun: true });
    expect(result).toMatchObject({
      scanned: 2,
      retried: ["a", "b"],
      dryRun: true,
    });
    expect(jobs[0].retry).not.toHaveBeenCalled();
  });

  it("retryAll collects per-job failures instead of aborting the batch", async () => {
    const jobs = [
      makeJob({ id: "a" }),
      makeJob({
        id: "b",
        retry: vi.fn().mockRejectedValue(new Error("locked")),
      }),
      makeJob({ id: "c" }),
    ];
    const dlq = new BullmqDlq(makeQueue(jobs));
    const result = await dlq.retryAll();
    expect(result.retried).toEqual(["a", "c"]);
    expect(result.failed).toEqual([{ jobId: "b", error: "locked" }]);
  });
});
