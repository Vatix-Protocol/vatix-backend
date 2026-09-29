import { describe, it, expect, vi } from "vitest";
import {
  withRetry,
  isRetryableError,
  isAbortError,
  normalizeRetryConfig,
  RetryConfigError,
  wait,
  DEFAULT_RETRY_CONFIG,
  MAX_RETRIES_LIMIT,
  MAX_DELAY_MS_LIMIT,
} from "./retry-utils.js";

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

    // #1117: a structured status is authoritative. Message sniffing alone
    // misreads payloads that merely contain digits ("tx 4001 failed") and
    // misses statuses the wrapper never puts in the message.
    it("classifies by structured HTTP status, not message text", () => {
      const withStatus = (status: number, message: string) => {
        const err = new Error(message) as Error & { status: number };
        err.status = status;
        return err;
      };

      expect(isRetryableError(withStatus(400, "upstream failure"))).toBe(false);
      expect(isRetryableError(withStatus(401, "upstream failure"))).toBe(false);
      expect(isRetryableError(withStatus(403, "upstream failure"))).toBe(false);
      expect(isRetryableError(withStatus(404, "upstream failure"))).toBe(false);
      expect(isRetryableError(withStatus(500, "upstream failure"))).toBe(true);
      expect(isRetryableError(withStatus(503, "upstream failure"))).toBe(true);
    });

    it("reads statusCode and response.status as well as status", () => {
      const statusCode = new Error("x") as Error & { statusCode: number };
      statusCode.statusCode = 400;
      expect(isRetryableError(statusCode)).toBe(false);

      const response = new Error("x") as Error & {
        response: { status: number };
      };
      response.response = { status: 502 };
      expect(isRetryableError(response)).toBe(true);
    });

    it("retries 408 and 429, which are 'try again' signals not verdicts", () => {
      const err = (status: number) =>
        Object.assign(new Error("x"), { status }) as Error;
      expect(isRetryableError(err(408))).toBe(true);
      expect(isRetryableError(err(429))).toBe(true);
    });

    it("still honours caller cancellation over the status field", () => {
      const abort = Object.assign(new Error("aborted"), {
        status: 503,
      }) as Error;
      abort.name = "AbortError";
      expect(isRetryableError(abort)).toBe(false);
    });
  });

  describe("normalizeRetryConfig", () => {
    it("merges partial overrides over the defaults", () => {
      expect(normalizeRetryConfig({ maxRetries: 0 })).toEqual({
        ...DEFAULT_RETRY_CONFIG,
        maxRetries: 0,
      });
    });

    it("returns the defaults when given nothing", () => {
      expect(normalizeRetryConfig()).toEqual(DEFAULT_RETRY_CONFIG);
      expect(normalizeRetryConfig({})).toEqual(DEFAULT_RETRY_CONFIG);
    });

    // Fail closed: a bad budget must be rejected up front, never turned into
    // a tight loop or an effectively infinite retry count on the money path.
    it("rejects a retry count above the hard ceiling", () => {
      expect(() =>
        normalizeRetryConfig({ maxRetries: MAX_RETRIES_LIMIT + 1 })
      ).toThrow(RetryConfigError);
      expect(
        normalizeRetryConfig({ maxRetries: MAX_RETRIES_LIMIT }).maxRetries
      ).toBe(MAX_RETRIES_LIMIT);
    });

    it("rejects negative, fractional, non-finite and non-numeric values", () => {
      for (const maxRetries of [
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        "3" as unknown as number,
      ]) {
        expect(() => normalizeRetryConfig({ maxRetries })).toThrow(
          RetryConfigError
        );
      }
    });

    it("rejects delays that would degenerate the backoff", () => {
      // A max below the initial delay truncates every delay to the ceiling.
      expect(() =>
        normalizeRetryConfig({ initialDelayMs: 5_000, maxDelayMs: 1_000 })
      ).toThrow(/maxDelayMs/);
      // A factor below 1 shrinks each delay until backoff stops backing off.
      expect(() => normalizeRetryConfig({ factor: 0.5 })).toThrow(/factor/);
      expect(() => normalizeRetryConfig({ initialDelayMs: -1 })).toThrow(
        /initialDelayMs/
      );
      expect(() =>
        normalizeRetryConfig({ maxDelayMs: MAX_DELAY_MS_LIMIT + 1 })
      ).toThrow(/maxDelayMs/);
    });

    it("rejects a non-boolean useJitter", () => {
      expect(() =>
        normalizeRetryConfig({ useJitter: "yes" as unknown as boolean })
      ).toThrow(/useJitter/);
    });

    it("exposes a stable error code and names the offending field", () => {
      try {
        normalizeRetryConfig({ maxRetries: -1 });
        expect.fail("should have thrown");
      } catch (err) {
        const e = err as RetryConfigError;
        expect(e).toBeInstanceOf(RetryConfigError);
        expect(e.code).toBe("RETRY_CONFIG_INVALID");
        expect(e.field).toBe("maxRetries");
      }
    });

    it("defaults useJitter to true and preserves an explicit false", () => {
      expect(normalizeRetryConfig().useJitter).toBe(true);
      expect(normalizeRetryConfig({ useJitter: false }).useJitter).toBe(false);
    });
  });

  describe("wait", () => {
    it("clamps non-positive and non-finite durations to zero", async () => {
      const started = Date.now();
      await wait(-5_000);
      await wait(Number.NaN);
      // Generous ceiling: this asserts "did not sleep for the requested time",
      // not timer precision.
      expect(Date.now() - started).toBeLessThan(500);
    });

    it("waits for the requested duration", async () => {
      const started = Date.now();
      await wait(30);
      expect(Date.now() - started).toBeGreaterThanOrEqual(20);
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

    // #1117: an invalid budget must never reach the operation — otherwise a
    // misconfigured provider turns into unbounded retries on the money path.
    it("rejects an invalid config without invoking the operation", async () => {
      const operation = vi.fn().mockResolvedValue("never");

      await expect(
        withRetry(operation, { maxRetries: MAX_RETRIES_LIMIT + 1 })
      ).rejects.toBeInstanceOf(RetryConfigError);
      await expect(withRetry(operation, { factor: 0 })).rejects.toBeInstanceOf(
        RetryConfigError
      );

      expect(operation).not.toHaveBeenCalled();
    });

    it("never exceeds the configured retry budget", async () => {
      const operation = vi.fn().mockRejectedValue(new Error("HTTP 503"));

      await expect(
        withRetry(operation, {
          maxRetries: 4,
          initialDelayMs: 1,
          useJitter: false,
        })
      ).rejects.toThrow("HTTP 503");

      // 1 initial call + exactly maxRetries retries, never more.
      expect(operation).toHaveBeenCalledTimes(5);
    });

    it("stops immediately at maxRetries: 0", async () => {
      const operation = vi.fn().mockRejectedValue(new Error("HTTP 503"));

      await expect(
        withRetry(operation, { maxRetries: 0, initialDelayMs: 1 })
      ).rejects.toThrow("HTTP 503");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("does not retry a 4xx carrying a structured status", async () => {
      const operation = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("request rejected"), { status: 422 })
        );

      await expect(
        withRetry(operation, { maxRetries: 3, initialDelayMs: 1 })
      ).rejects.toThrow("request rejected");
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });
});
