import { describe, it, expect, vi } from "vitest";
import { withRetry, isRetryableError, isAbortError } from "./retry-utils.js";

describe("retry-utils", () => {
  describe("isRetryableError", () => {
    it("returns true for network errors", () => {
      expect(isRetryableError(new Error("Network timeout"))).toBe(true);
      expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
    });

    it("returns true for 5xx errors", () => {
      expect(isRetryableError(new Error("HTTP 503 Service Unavailable"))).toBe(
        true
      );
    });

    it("returns false for 4xx client errors (non-retryable)", () => {
      expect(isRetryableError(new Error("HTTP 400 Bad Request"))).toBe(false);
      expect(isRetryableError(new Error("Invalid configuration"))).toBe(false);
    });

    it("returns true for non-Error objects", () => {
      expect(isRetryableError("Something went wrong")).toBe(true);
    });

    // #1109/#1111: an abort is a decision, not a transient fault. Retrying it
    // restarts work the caller cancelled and can outlast the shutdown that
    // triggered the cancellation.
    it("returns false for caller cancellation", () => {
      const abort = new Error("The operation was aborted");
      abort.name = "AbortError";
      expect(isRetryableError(abort)).toBe(false);

      expect(
        isRetryableError(new Error("Price fetch cancelled by caller"))
      ).toBe(false);
    });
  });

  describe("isAbortError", () => {
    it("recognises an AbortError by name", () => {
      const abort = new Error("x");
      abort.name = "AbortError";
      expect(isAbortError(abort)).toBe(true);
    });

    it("recognises abort wording regardless of name", () => {
      expect(isAbortError(new Error("Operation was aborted"))).toBe(true);
      expect(isAbortError(new Error("request canceled"))).toBe(true);
    });

    it("does not classify a deadline overrun as a cancellation", () => {
      // A timeout is transient and must stay retryable; treating it as a
      // cancellation would silently stop retrying a flaky provider.
      const timeout = new Error("Provider timed out after 30000ms");
      timeout.name = "TimeoutError";
      expect(isAbortError(timeout)).toBe(false);
      expect(isRetryableError(timeout)).toBe(true);
    });

    it("does not classify ordinary errors as aborts", () => {
      expect(isAbortError(new Error("HTTP 503"))).toBe(false);
      expect(isAbortError("not an error")).toBe(false);
    });
  });

  describe("withRetry", () => {
    it("returns the result if the operation succeeds first time", async () => {
      const operation = vi.fn().mockResolvedValue("success");
      const result = await withRetry(operation, { maxRetries: 3 });

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("retries on failure and eventually succeeds", async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error("Transient error"))
        .mockRejectedValueOnce(new Error("Another transient error"))
        .mockResolvedValue("success");

      const onRetry = vi.fn();
      const result = await withRetry(
        operation,
        {
          maxRetries: 3,
          initialDelayMs: 1,
          useJitter: false,
        },
        onRetry
      );

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(3);
      expect(onRetry).toHaveBeenCalledTimes(2);
    });

    it("throws the last error if all retries fail", async () => {
      const error = new Error("Persistent error");
      const operation = vi.fn().mockRejectedValue(error);

      await expect(
        withRetry(operation, {
          maxRetries: 2,
          initialDelayMs: 1,
          useJitter: false,
        })
      ).rejects.toThrow("Persistent error");

      expect(operation).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it("does not retry if error is not retryable", async () => {
      const error = new Error("HTTP 400 Bad Request");
      const operation = vi.fn().mockRejectedValue(error);

      await expect(
        withRetry(operation, {
          maxRetries: 3,
          initialDelayMs: 1,
          useJitter: false,
        })
      ).rejects.toThrow("HTTP 400 Bad Request");

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("does not retry an aborted operation", async () => {
      const abort = new Error("The operation was aborted");
      abort.name = "AbortError";
      const operation = vi.fn().mockRejectedValue(abort);

      await expect(
        withRetry(operation, {
          maxRetries: 3,
          initialDelayMs: 1,
          useJitter: false,
        })
      ).rejects.toThrow(abort);

      // Retrying a cancellation restarts work the caller already gave up on.
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("applies exponential backoff", async () => {
      // This is hard to test exactly with real timers, but we can verify the delays passed to onRetry
      const operation = vi.fn().mockRejectedValue(new Error("Transient"));
      const onRetry = vi.fn();

      const maxRetries = 2;
      const initialDelayMs = 10;

      try {
        await withRetry(
          operation,
          {
            maxRetries,
            initialDelayMs,
            factor: 2,
            useJitter: false,
          },
          onRetry
        );
      } catch (e) {
        // Expected failure
      }

      // Attempt 1: delay = 10 * 2^0 = 10
      // Attempt 2: delay = 10 * 2^1 = 20
      expect(onRetry).toHaveBeenNthCalledWith(1, expect.any(Error), 1, 10);
      expect(onRetry).toHaveBeenNthCalledWith(2, expect.any(Error), 2, 20);
    });
  });
});
