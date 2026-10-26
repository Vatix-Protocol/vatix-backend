import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  processJob,
  JobTimeoutError,
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

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("should invoke the handler with the job", async () => {
    const handler: JobHandler = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig();
    const job = makeJob();

    await processJob(logger, config, job, handler);

    expect(handler).toHaveBeenCalledWith(job);
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
        timedOut: true,
      })
    );
  });

  it("clears the timeout timer handle on the timeout path", async () => {
    vi.useFakeTimers();

    const handler: JobHandler = vi
      .fn()
      .mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 10_000))
      );
    const config = makeConfig({ processingTimeoutMs: 100 });
    const job = makeJob();

    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    const promise = processJob(logger, config, job, handler);
    vi.advanceTimersByTime(150);

    await expect(promise).rejects.toBeInstanceOf(JobTimeoutError);

    expect(clearSpy).toHaveBeenCalled();
  });

  it("clears the timeout timer handle on the success path", async () => {
    vi.useFakeTimers();

    const handler: JobHandler = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig({ processingTimeoutMs: 5000 });
    const job = makeJob();

    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    await processJob(logger, config, job, handler);

    expect(clearSpy).toHaveBeenCalled();
  });

  it("clears the timeout timer handle on the failure path", async () => {
    vi.useFakeTimers();

    const handler: JobHandler = vi.fn().mockRejectedValue(new Error("boom"));
    const config = makeConfig({ processingTimeoutMs: 5000, maxAttempts: 1 });
    const job = makeJob({ attempts: 1 });

    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    await expect(processJob(logger, config, job, handler)).rejects.toThrow(
      "boom"
    );

    expect(clearSpy).toHaveBeenCalled();
  });

  it("does not emit unhandledRejection when handler rejects after the timeout", async () => {
    vi.useFakeTimers();

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      let rejectHandler: ((err: Error) => void) | undefined;
      const handler: JobHandler = vi.fn().mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectHandler = reject;
          })
      );
      const config = makeConfig({ processingTimeoutMs: 100 });
      const job = makeJob();

      const promise = processJob(logger, config, job, handler);
      vi.advanceTimersByTime(150);

      await expect(promise).rejects.toBeInstanceOf(JobTimeoutError);

      // Handler rejects after the timeout has already fired
      rejectHandler?.(new Error("late failure"));

      // Flush microtasks so any unhandled rejection would surface
      await Promise.resolve();
      await Promise.resolve();

      expect(unhandled).not.toHaveBeenCalled();

      // Late rejection is contained and logged at warn with the jobId
      expect(logger.warn).toHaveBeenCalledWith(
        "Job handler rejected after timeout",
        expect.objectContaining({
          jobId: "job-1",
          queue: "test-queue",
          error: "late failure",
        })
      );
    } finally {
      process.off("unhandledRejection", unhandled);
    }
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
