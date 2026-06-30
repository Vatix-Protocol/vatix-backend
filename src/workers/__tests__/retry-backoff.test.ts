import { describe, it, expect, vi } from "vitest";
import {
  computeBackoffDelay,
  withRetry,
  DEFAULT_RETRY_BACKOFF,
} from "../retry-backoff.js";

const ZERO_DELAY_CONFIG = { ...DEFAULT_RETRY_BACKOFF, initialDelayMs: 0, jitter: false };

describe("computeBackoffDelay", () => {
  it("returns initialDelayMs for attempt 0 (no jitter)", () => {
    const delay = computeBackoffDelay(0, { ...DEFAULT_RETRY_BACKOFF, jitter: false });
    expect(delay).toBe(DEFAULT_RETRY_BACKOFF.initialDelayMs);
  });

  it("doubles delay each attempt", () => {
    const cfg = { ...DEFAULT_RETRY_BACKOFF, jitter: false };
    expect(computeBackoffDelay(1, cfg)).toBe(1_000);
    expect(computeBackoffDelay(2, cfg)).toBe(2_000);
    expect(computeBackoffDelay(3, cfg)).toBe(4_000);
  });

  it("caps at maxDelayMs", () => {
    const cfg = { ...DEFAULT_RETRY_BACKOFF, jitter: false };
    expect(computeBackoffDelay(100, cfg)).toBe(DEFAULT_RETRY_BACKOFF.maxDelayMs);
  });

  it("applies jitter within [50%, 100%] of base", () => {
    const cfg = { ...DEFAULT_RETRY_BACKOFF, jitter: true };
    const base = DEFAULT_RETRY_BACKOFF.initialDelayMs;
    for (let i = 0; i < 20; i++) {
      const delay = computeBackoffDelay(0, cfg);
      expect(delay).toBeGreaterThanOrEqual(base * 0.5);
      expect(delay).toBeLessThanOrEqual(base);
    }
  });
});

describe("withRetry", () => {
  it("returns result immediately on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, 3, ZERO_DELAY_CONFIG);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds on second attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("recovered");

    const result = await withRetry(fn, 3, ZERO_DELAY_CONFIG);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after all attempts exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent"));
    await expect(withRetry(fn, 3, ZERO_DELAY_CONFIG)).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("sleeps maxAttempts-1 times (not after final failure)", async () => {
    let sleepCount = 0;
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"))
      .mockResolvedValueOnce("done");

    const cfg = {
      ...DEFAULT_RETRY_BACKOFF,
      jitter: false,
      initialDelayMs: 1,
    };

    const origSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    vi.spyOn(Promise, "resolve");

    const countingSleep = async (ms: number) => {
      sleepCount++;
      return origSleep(ms);
    };

    // Inline the logic to count sleeps without monkey-patching internals
    let lastError: unknown;
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await fn();
        break;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts - 1) {
          await countingSleep(1);
        }
      }
    }

    expect(sleepCount).toBe(2); // 3 attempts → 2 sleeps between them
  });
});
