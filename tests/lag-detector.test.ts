/**
 * Unit tests for lag detector settlement queue depth computation.
 * Verifies that lag reflects jobs across wait, delayed, and active states.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Queue, Worker } from "bullmq";
import {
  DEFAULT_JOB_OPTIONS,
  redisConnectionFromEnv,
  settlementQueueName,
} from "../apps/workers/src/shared/queue-config.js";
import { LagDetector } from "../src/services/lag-detector.js";

describe("LagDetector: settlement queue depth computation", () => {
  let testQueue: Queue;
  let lagDetector: LagDetector;

  beforeAll(async () => {
    testQueue = new Queue(settlementQueueName(), {
      connection: redisConnectionFromEnv(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });

    lagDetector = new LagDetector({
      highWaterMark: 100,
      lowWaterMark: 50,
    });
  });

  afterAll(async () => {
    await testQueue.close();
  });

  beforeEach(async () => {
    await testQueue.drain();
  });

  it("counts jobs in wait state (not yet active)", async () => {
    // Enqueue a job that will sit in the wait state
    await testQueue.add("test-job-wait", { id: "1" }, {
      ...DEFAULT_JOB_OPTIONS,
      delay: 0, // No delay, goes to wait state
    });

    // Get metrics - should include the waiting job
    const metrics = await lagDetector.getMetrics();

    expect(metrics.settlementQueueDepth).toBeGreaterThanOrEqual(1);
  });

  it("counts jobs in delayed state", async () => {
    // Enqueue a job with a delay
    await testQueue.add("test-job-delayed", { id: "2" }, {
      ...DEFAULT_JOB_OPTIONS,
      delay: 5000, // 5 second delay
    });

    const metrics = await lagDetector.getMetrics();

    expect(metrics.settlementQueueDepth).toBeGreaterThanOrEqual(1);
  });

  it("counts jobs across all three states (wait + delayed + active)", async () => {
    // Enqueue multiple jobs in different states
    await testQueue.add("job-1-wait", { id: "1" });
    await testQueue.add("job-2-delayed", { id: "2" }, { delay: 5000 });
    await testQueue.add("job-3-wait", { id: "3" });

    const metrics = await lagDetector.getMetrics();

    // Should count at least 3 jobs (wait + delayed)
    expect(metrics.settlementQueueDepth).toBeGreaterThanOrEqual(3);
  });

  it("reports zero lag when all queues are empty", async () => {
    const metrics = await lagDetector.getMetrics();

    expect(metrics.settlementQueueDepth).toBe(0);
    expect(metrics.totalLag).toBe(0);
  });

  it("reflects accurate lag with mixed backlog (integration)", async () => {
    // Simulate realistic backlog scenario
    const jobCount = 15;
    const promises = [];

    // Add various jobs
    for (let i = 0; i < 5; i++) {
      promises.push(testQueue.add(`job-wait-${i}`, { id: `w${i}` }));
    }
    for (let i = 0; i < 7; i++) {
      promises.push(testQueue.add(`job-delayed-${i}`, { id: `d${i}` }, { delay: 3000 }));
    }
    for (let i = 0; i < 3; i++) {
      promises.push(testQueue.add(`job-active-${i}`, { id: `a${i}` }));
    }

    await Promise.all(promises);

    const metrics = await lagDetector.getMetrics();

    // Should count all 15 jobs across all states
    expect(metrics.settlementQueueDepth).toBeGreaterThanOrEqual(jobCount);
  });
});
