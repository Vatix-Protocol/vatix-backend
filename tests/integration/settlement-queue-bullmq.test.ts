/**
 * Integration test: settlement queue producer → BullMQ consumer.
 *
 * Verifies that settlementQueue.enqueue() writes a settlement job to the BullMQ queue
 * with the correct shape, and the BullMQ settlement worker can pick it up and process it.
 * This catches regressions where the producer/consumer queue-technology mismatch
 * prevents settlements from being processed.
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
import { Queue, Worker } from "bullmq";
import {
  DEFAULT_JOB_OPTIONS,
  redisConnectionFromEnv,
  settlementQueueName,
} from "../../apps/workers/src/shared/queue-config.js";
import { settlementQueue, type SettlementJob } from "../../src/services/settlement-queue.js";
import type { QueueJob } from "../../apps/workers/src/consumers/queue-consumer.js";

describe("Settlement queue: producer → BullMQ consumer", () => {
  let testQueue: Queue<SettlementJob>;
  let processedJobs: QueueJob[] = [];

  beforeAll(async () => {
    testQueue = new Queue<SettlementJob>(settlementQueueName(), {
      connection: redisConnectionFromEnv(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  });

  afterAll(async () => {
    await testQueue.close();
  });

  beforeEach(async () => {
    processedJobs = [];
    // Clear the queue before each test
    await testQueue.drain();
  });

  it("enqueues a settlement job to BullMQ and worker can retrieve it", async () => {
    const testJob: SettlementJob = {
      tradeId: "test-trade-1",
      marketId: "market-1",
      outcome: "YES",
      buyOrderId: "buy-1",
      sellOrderId: "sell-1",
      buyerAddress: "GBUYER",
      sellerAddress: "GSELLER",
      price: 0.5,
      quantity: 10,
      timestamp: Date.now(),
    };

    // Enqueue the job
    await settlementQueue.enqueue(testJob);

    // Create a test worker to verify the job is retrievable
    const worker = new Worker<SettlementJob>(
      settlementQueueName(),
      async (job) => {
        processedJobs.push({
          id: job.id ?? job.name,
          payload: job.data,
          attempts: job.attemptsMade + 1,
        });
      },
      {
        connection: redisConnectionFromEnv(),
        concurrency: 1,
      }
    );

    // Wait for the worker to process the job
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await worker.close();

    // Verify the job was processed with correct data
    expect(processedJobs).toHaveLength(1);
    const processedJob = processedJobs[0];
    expect(processedJob.payload).toEqual(testJob);
    expect(processedJob.payload.tradeId).toBe("test-trade-1");
    expect(processedJob.payload.marketId).toBe("market-1");
    expect(processedJob.payload.outcome).toBe("YES");
  });

  it("preserves job data shape for settlement worker validation", async () => {
    const testJob: SettlementJob = {
      tradeId: "test-trade-2",
      marketId: "market-2",
      outcome: "NO",
      buyOrderId: "buy-2",
      sellOrderId: "sell-2",
      buyerAddress: "GBUYER2",
      sellerAddress: "GSELLER2",
      price: 0.75,
      quantity: 20,
      timestamp: 1700000000000,
    };

    await settlementQueue.enqueue(testJob);

    const retrievedJob = await testQueue.getJob(`settlement:${testJob.tradeId}`);
    expect(retrievedJob).toBeDefined();
    expect(retrievedJob?.data).toEqual(testJob);
  });
});
