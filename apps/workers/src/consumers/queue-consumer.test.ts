import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  processJob,
  JobTimeoutError,
  InvalidQueueConsumerConfigError,
  assertValidConsumerConfig,
  assertValidJobAttempts,
  QUEUE_CONSUMER_CONFIG_CODES,
  type QueueJob,
  type QueueConsumerConfig,
  type JobHandler,
} from "./queue-consumer.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";

function makeLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

function makeConfig(
  overrides?: Partial<QueueConsumerConfig>
): QueueConsumerConfig {
  return {
    queueName: "test-queue",
    maxAttempts: 3,
    processingTimeoutMs: 5000,
    ...overrides,
  };
}

function makeJob(overrides?: Partial<QueueJob>): QueueJob {
  return {
    id: "job-1",
    payload: { key: "value" },
    attempts: 1,
    ...overrides,
  };
}

describe("Queue Consumer — processJob", () => {
  let logger: ILogger;

  beforeEach(() => {
    logger = makeLogger();
  });

  it("should log job receipt and completion on success", async () => {
    const handler: JobHandler = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig();
    const job = makeJob();

    await processJob(logger, config, job, handler);

    expect(logger.info).toHaveBeenCalledWith(
      "Job received from queue",
      expect.objectContaining({
        jobId: "job-1",
        queue: "test-queue",
        attempt: 1,
        maxAttempts: 3,
      })
    );

    expect(logger.info).toHaveBeenCalledWith(
      "Job processed successfully",
      expect.objectContaining({
        jobId: "job-1",
        queue: "test-queue",
        attempt: 1,
        durationMs: expect.any(Number),
      })
    );
  });

  it("should invoke the handler with the job and a cancellation signal", async () => {
    const handler: JobHandler = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig();
    const job = makeJob();

    await processJob(logger, config, job, handler);

    expect(handler).toHaveBeenCalledWith(job, expect.any(AbortSignal));
  });

  it("should log warn and re-throw when attempts remain", async () => {
    const error = new Error("transient failure");
    const handler: JobHandler = vi.fn().mockRejectedValue(error);
    const config = makeConfig({ maxAttempts: 3 });
    const job = makeJob({ attempts: 1 });

    await expect(processJob(logger, config, job, handler)).rejects.toThrow(
      "transient failure"
    );

    expect(logger.warn).toHaveBeenCalledWith(
      "Job processing failed, will retry",
      expect.objectContaining({
        jobId: "job-1",
        queue: "test-queue",
        attempt: 1,
        maxAttempts: 3,
        error: "transient failure",
      })
    );

    expect(logger.error).not.toHaveBeenCalled();
  });

  it("should log error when max attempts exceeded", async () => {
    const error = new Error("permanent failure");
    const handler: JobHandler = vi.fn().mockRejectedValue(error);
    const config = makeConfig({ maxAttempts: 3 });
    const job = makeJob({ attempts: 3 });

    await expect(processJob(logger, config, job, handler)).rejects.toThrow(
      "permanent failure"
    );

    expect(logger.error).toHaveBeenCalledWith(
      "Job processing failed, max attempts exceeded",
      expect.objectContaining({
        jobId: "job-1",
        queue: "test-queue",
        attempt: 3,
        maxAttempts: 3,
        error: "permanent failure",
      })
    );

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("should include durationMs in success log", async () => {
    const handler: JobHandler = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig();
    const job = makeJob();

    await processJob(logger, config, job, handler);

    const successCall = (
      logger.info as ReturnType<typeof vi.fn>
    ).mock.calls.find((call) => call[0] === "Job processed successfully");
    expect(successCall).toBeDefined();
    expect(successCall![1].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should include durationMs in failure log", async () => {
    const handler: JobHandler = vi.fn().mockRejectedValue(new Error("fail"));
    const config = makeConfig({ maxAttempts: 1 });
    const job = makeJob({ attempts: 1 });

    await expect(processJob(logger, config, job, handler)).rejects.toThrow();

    const errorCall = (
      logger.error as ReturnType<typeof vi.fn>
    ).mock.calls.find(
      (call) => call[0] === "Job processing failed, max attempts exceeded"
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![1].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should handle non-Error thrown values", async () => {
    const handler: JobHandler = vi.fn().mockRejectedValue("string error");
    const config = makeConfig({ maxAttempts: 1 });
    const job = makeJob({ attempts: 1 });

    await expect(processJob(logger, config, job, handler)).rejects.toBe(
      "string error"
    );

    expect(logger.error).toHaveBeenCalledWith(
      "Job processing failed, max attempts exceeded",
      expect.objectContaining({
        error: "string error",
      })
    );
  });

  // -------------------------------------------------------------------------
  // Timeout enforcement (reliability pass 038)
  // -------------------------------------------------------------------------

  it("rejects with JobTimeoutError when handler exceeds processingTimeoutMs", async () => {
    vi.useFakeTimers();

    // Handler that never resolves within the timeout window
    const handler: JobHandler = vi
      .fn()
      .mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 10_000))
      );
    const config = makeConfig({ processingTimeoutMs: 100 });
    const job = makeJob();

    const promise = processJob(logger, config, job, handler);

    // Advance time past the timeout threshold
    vi.advanceTimersByTime(150);

    await expect(promise).rejects.toBeInstanceOf(JobTimeoutError);

    vi.useRealTimers();
  });

  it("logs warn with timedOut context when handler times out", async () => {
    vi.useFakeTimers();

    const handler: JobHandler = vi
      .fn()
      .mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 10_000))
      );
    const config = makeConfig({ processingTimeoutMs: 100 });
    const job = makeJob();

    const promise = processJob(logger, config, job, handler);
    vi.advanceTimersByTime(150);

    await expect(promise).rejects.toBeInstanceOf(JobTimeoutError);

    expect(logger.warn).toHaveBeenCalledWith(
      "Job processing timed out",
      expect.objectContaining({
        jobId: "job-1",
        queue: "test-queue",
        processingTimeoutMs: 100,
      })
    );

    vi.useRealTimers();
  });

  it("does not trigger timeout when handler resolves before the deadline", async () => {
    vi.useFakeTimers();

    const handler: JobHandler = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig({ processingTimeoutMs: 5000 });
    const job = makeJob();

    const promise = processJob(logger, config, job, handler);

    // Handler resolves synchronously (mocked), time does not matter
    await promise;

    expect(logger.info).toHaveBeenCalledWith(
      "Job processed successfully",
      expect.objectContaining({ jobId: "job-1" })
    );

    vi.useRealTimers();
  });

  it("JobTimeoutError carries jobId and timeoutMs", () => {
    const err = new JobTimeoutError("job-42", 3000);
    expect(err.jobId).toBe("job-42");
    expect(err.timeoutMs).toBe(3000);
    expect(err.name).toBe("JobTimeoutError");
    expect(err.message).toContain("job-42");
    expect(err.message).toContain("3000");
  });
});

describe("Queue Consumer — fail-closed configuration validation (#1105)", () => {
  it("accepts a well-formed config", () => {
    expect(() =>
      assertValidConsumerConfig({
        queueName: "settlement",
        maxAttempts: 3,
        processingTimeoutMs: 5_000,
      })
    ).not.toThrow();
  });

  it.each([
    ["maxAttempts = 0", { maxAttempts: 0 }, "INVALID_MAX_ATTEMPTS"],
    ["maxAttempts = -1", { maxAttempts: -1 }, "INVALID_MAX_ATTEMPTS"],
    ["maxAttempts = NaN", { maxAttempts: NaN }, "INVALID_MAX_ATTEMPTS"],
    ["maxAttempts = 1.5", { maxAttempts: 1.5 }, "INVALID_MAX_ATTEMPTS"],
    [
      "processingTimeoutMs = 0",
      { processingTimeoutMs: 0 },
      "INVALID_PROCESSING_TIMEOUT",
    ],
    [
      "processingTimeoutMs = NaN",
      { processingTimeoutMs: NaN },
      "INVALID_PROCESSING_TIMEOUT",
    ],
    [
      "processingTimeoutMs = Infinity",
      { processingTimeoutMs: Infinity },
      "INVALID_PROCESSING_TIMEOUT",
    ],
    ["queueName = ''", { queueName: "" }, "INVALID_QUEUE_NAME"],
  ] as Array<[string, Partial<QueueConsumerConfig>, string]>)(
    "rejects %s with a stable code",
    (_label, overrides, expectedCodeKey) => {
      let thrown: unknown;
      try {
        assertValidConsumerConfig({
          queueName: "settlement",
          maxAttempts: 3,
          processingTimeoutMs: 5_000,
          ...overrides,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(InvalidQueueConsumerConfigError);
      expect((thrown as InvalidQueueConsumerConfigError).code).toBe(
        QUEUE_CONSUMER_CONFIG_CODES[
          expectedCodeKey as keyof typeof QUEUE_CONSUMER_CONFIG_CODES
        ]
      );
    }
  );

  it("rejects a queue name carrying control characters (log-forging vector)", () => {
    expect(() =>
      assertValidConsumerConfig({
        queueName: "settlement\nFAKE_LEVEL info",
        maxAttempts: 3,
        processingTimeoutMs: 5_000,
      })
    ).toThrow(InvalidQueueConsumerConfigError);
  });

  it("rejects a job whose attempts counter cannot be trusted", () => {
    for (const attempts of [0, -1, NaN, 1.5]) {
      expect(() =>
        assertValidJobAttempts({ id: "job-1", payload: {}, attempts })
      ).toThrow(InvalidQueueConsumerConfigError);
    }
  });

  it("processJob refuses to run the handler on an invalid config (fail-closed)", async () => {
    const logger = makeLogger();
    const handler: JobHandler = vi.fn().mockResolvedValue(undefined);

    // maxAttempts: 0 would otherwise dead-letter this job on its first
    // delivery without ever running the handler.
    await expect(
      processJob(
        logger,
        { queueName: "settlement", maxAttempts: 0, processingTimeoutMs: 5_000 },
        makeJob(),
        handler
      )
    ).rejects.toBeInstanceOf(InvalidQueueConsumerConfigError);

    expect(handler).not.toHaveBeenCalled();
  });

  it("processJob refuses a job with an untrustworthy attempts counter", async () => {
    const logger = makeLogger();
    const handler: JobHandler = vi.fn().mockResolvedValue(undefined);

    await expect(
      processJob(logger, makeConfig(), makeJob({ attempts: 0 }), handler)
    ).rejects.toMatchObject({
      name: "InvalidQueueConsumerConfigError",
      code: QUEUE_CONSUMER_CONFIG_CODES.INVALID_JOB_ATTEMPTS,
    });

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("Queue Consumer — correlation id and cancellation (#1105)", () => {
  it("propagates a producer-supplied correlationId onto every log line", async () => {
    const logger = makeLogger();

    await processJob(
      logger,
      makeConfig(),
      makeJob({ correlationId: "corr-123" }),
      vi.fn().mockResolvedValue(undefined)
    );

    const lines = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ];
    expect(lines.length).toBeGreaterThan(0);
    for (const [, meta] of lines) {
      expect((meta as Record<string, unknown>).correlationId).toBe("corr-123");
    }
  });

  it("falls back to the job id when no correlationId is supplied", async () => {
    const logger = makeLogger();

    await processJob(
      logger,
      makeConfig(),
      makeJob(),
      vi.fn().mockResolvedValue(undefined)
    );

    expect(logger.info).toHaveBeenCalledWith(
      "Job received from queue",
      expect.objectContaining({ correlationId: "job-1" })
    );
  });

  it("aborts the handler's signal when the processing timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      let observed: AbortSignal | undefined;

      const promise = processJob(
        makeLogger(),
        makeConfig({ processingTimeoutMs: 100 }),
        makeJob(),
        (_job, signal) => {
          observed = signal;
          return new Promise<void>((resolve) => setTimeout(resolve, 10_000));
        }
      );

      expect(observed?.aborted).toBe(false);
      vi.advanceTimersByTime(150);
      await expect(promise).rejects.toBeInstanceOf(JobTimeoutError);

      // The handler is told it has been abandoned so it can stop burning RPC
      // quota instead of running to completion in the background.
      expect(observed?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the handler's signal un-aborted on success", async () => {
    let observed: AbortSignal | undefined;

    await processJob(makeLogger(), makeConfig(), makeJob(), (_job, signal) => {
      observed = signal;
      return Promise.resolve();
    });

    expect(observed?.aborted).toBe(false);
  });
});
