/**
 * Integration test: oracle main → BullMQ submission queue.
 *
 * Verifies that the oracle main submission flow writes oracle submissions to
 * the BullMQ queue (not Redis Streams) so they reach the oracle worker for
 * on-chain submission.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { Queue } from "bullmq";
import {
  redisConnectionFromEnv,
  submissionQueueName,
} from "../../apps/workers/src/shared/queue-config.js";
import { BullMQSubmissionQueue } from "../../apps/workers/src/oracle/bullmq-submission-queue.js";
import type { SubmissionQueueItem } from "../../apps/oracle/submission-queue.js";

describe("Oracle submission: BullMQ queue enqueue", () => {
  let testQueue: Queue<SubmissionQueueItem>;
  let submissionQueue: BullMQSubmissionQueue;
  let mockLogger: any;

  beforeAll(async () => {
    testQueue = new Queue<SubmissionQueueItem>(submissionQueueName(), {
      connection: redisConnectionFromEnv(),
    });

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    submissionQueue = new BullMQSubmissionQueue(mockLogger);
  });

  afterAll(async () => {
    await testQueue.close();
    await submissionQueue.close();
  });

  beforeEach(async () => {
    await testQueue.drain();
    vi.clearAllMocks();
  });

  it("enqueues oracle submission to BullMQ queue", async () => {
    const submission: SubmissionQueueItem = {
      id: "test-submission-1",
      request: {
        marketId: "market-1",
        oracleAddress: "GORACLE",
      },
      result: {
        outcome: "YES",
        confidence: 0.95,
        timestamp: Date.now(),
        signature: "sig123",
        publicKey: "pk123",
      },
      status: "pending",
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    };

    const enqueued = await submissionQueue.enqueue(submission);

    expect(enqueued).toBe(true);
    expect(mockLogger.info).toHaveBeenCalled();

    // Verify job is in BullMQ queue
    const jobId = `market-1:${submission.result.signature.slice(0, 16)}`;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const jobs = await testQueue.getJobs();
    expect(jobs.length).toBeGreaterThan(0);
  });

  it("deduplicates identical submissions", async () => {
    const submission: SubmissionQueueItem = {
      id: "test-submission-2",
      request: {
        marketId: "market-2",
        oracleAddress: "GORACLE",
      },
      result: {
        outcome: "NO",
        confidence: 0.8,
        timestamp: Date.now(),
        signature: "sig456",
        publicKey: "pk456",
      },
      status: "pending",
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    };

    const enqueued1 = await submissionQueue.enqueue(submission);
    expect(enqueued1).toBe(true);

    // Second identical enqueue should return false (deduplication)
    const enqueued2 = await submissionQueue.enqueue({
      ...submission,
      id: "test-submission-2-retry",
      enqueuedAt: new Date().toISOString(),
    });

    expect(enqueued2).toBe(false);
  });
});
