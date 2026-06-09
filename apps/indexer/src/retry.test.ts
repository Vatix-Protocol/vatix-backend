import { describe, it, expect, vi } from "vitest";
import { isTransientError, withRetry, RetryValidationError } from "./retry.js";

// ─── isTransientError ────────────────────────────────────────────────────────

describe("isTransientError", () => {
  it("returns true for ECONNRESET", () => {
    const err = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    expect(isTransientError(err)).toBe(true);
  });

  it("returns true for ECONNREFUSED", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(isTransientError(err)).toBe(true);
  });

  it("returns true for ETIMEDOUT", () => {
    const err = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    expect(isTransientError(err)).toBe(true);
  });

  it("returns true for socket hang up by message", () => {
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
  });

  it("returns false for non-transient errors", () => {
    expect(isTransientError(new Error("bad request"))).toBe(false);
    expect(isTransientError(new Error("Not Found"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isTransientError("string error")).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(42)).toBe(false);
  });
});

// ─── withRetry ───────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns the result when the operation succeeds on the first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, retryDelayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient error and returns result on eventual success", async () => {
    const transient = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, { maxRetries: 3, retryDelayMs: 0 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("applies exponential backoff between retries", async () => {
    vi.useFakeTimers();
    const transient = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const fn = vi.fn().mockRejectedValueOnce(transient).mockResolvedValue("ok");

    const resultPromise = withRetry(fn, { maxRetries: 1, retryDelayMs: 100 });
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("throws after exhausting all retries", async () => {
    const err = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, { maxRetries: 2, retryDelayMs: 0 })
    ).rejects.toThrow("socket hang up");

    // 1 initial attempt + 2 retries
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-transient errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("bad request"));

    await expect(
      withRetry(fn, { maxRetries: 3, retryDelayMs: 0 })
    ).rejects.toThrow("bad request");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects maxRetries: 0 (no retries)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
      );

    await expect(
      withRetry(fn, { maxRetries: 0, retryDelayMs: 0 })
    ).rejects.toThrow("socket hang up");

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─── withRetry input validation ───────────────────────────────────────────────

describe("withRetry input validation", () => {
  it("throws RetryValidationError (statusCode 400) for negative maxRetries", async () => {
    await expect(
      withRetry(() => Promise.resolve("ok"), {
        maxRetries: -1,
        retryDelayMs: 0,
      })
    ).rejects.toThrow(RetryValidationError);

    await expect(
      withRetry(() => Promise.resolve("ok"), {
        maxRetries: -1,
        retryDelayMs: 0,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("throws RetryValidationError (statusCode 400) for non-integer maxRetries", async () => {
    await expect(
      withRetry(() => Promise.resolve("ok"), {
        maxRetries: 1.5,
        retryDelayMs: 0,
      })
    ).rejects.toThrow(RetryValidationError);
  });

  it("throws RetryValidationError (statusCode 400) for negative retryDelayMs", async () => {
    await expect(
      withRetry(() => Promise.resolve("ok"), {
        maxRetries: 1,
        retryDelayMs: -1,
      })
    ).rejects.toThrow(RetryValidationError);

    await expect(
      withRetry(() => Promise.resolve("ok"), {
        maxRetries: 1,
        retryDelayMs: -1,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("throws RetryValidationError (statusCode 400) for NaN retryDelayMs", async () => {
    await expect(
      withRetry(() => Promise.resolve("ok"), {
        maxRetries: 1,
        retryDelayMs: NaN,
      })
    ).rejects.toThrow(RetryValidationError);
  });
});
