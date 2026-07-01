import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  RetryableError,
  ProviderRetryError,
  isRetryableError,
  retryWithBackoff,
} from "./providerRetry";

describe("provider retry helper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks a wrapped error as retryable", () => {
    const original = new Error("transient network failure");
    const retryable = RetryableError.wrap(original, "retry later");

    expect(retryable).toBeInstanceOf(RetryableError);
    expect(retryable.retryable).toBe(true);
    expect(retryable.cause).toBe(original);
    expect(isRetryableError(retryable)).toBe(true);
  });

  it("resolves on the first attempt when the operation succeeds", async () => {
    const operation = vi.fn().mockResolvedValue("ok");

    const result = await retryWithBackoff(operation, {
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 2,
      jitter: false,
    });

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors and eventually succeeds", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("temporary provider failure"))
      .mockResolvedValue("success");

    const result = await retryWithBackoff(operation, {
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 2,
      jitter: false,
    });

    expect(result).toBe("success");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable errors", async () => {
    const failure = new Error("permanent provider failure");
    const operation = vi.fn().mockRejectedValue(failure);

    await expect(
      retryWithBackoff(operation, {
        maxAttempts: 4,
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitter: false,
      })
    ).rejects.toThrow(ProviderRetryError);

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("fails after the maximum retry attempts with context", async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(new RetryableError("intermittent outage"));

    await expect(
      retryWithBackoff(operation, {
        maxAttempts: 3,
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitter: false,
      })
    ).rejects.toMatchObject({
      name: "ProviderRetryError",
      attempts: 3,
      message: expect.stringContaining(
        "Provider operation failed after 3 attempts"
      ),
    });

    expect(operation).toHaveBeenCalledTimes(3);
  });
});
