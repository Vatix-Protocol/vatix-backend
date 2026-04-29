/**
 * Unit tests for Timeout Utilities
 *
 * Covers timeout validation, signal creation, and withTimeout behavior.
 */

import { describe, it, expect, vi } from "vitest";
import {
  validateTimeout,
  createTimeoutSignal,
  withTimeout,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  formatDuration,
} from "./timeout-utils.js";

describe("validateTimeout", () => {
  it("should return valid timeout as-is", () => {
    expect(validateTimeout(10_000)).toBe(10_000);
  });

  it("should return default for NaN", () => {
    expect(validateTimeout(NaN)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("should return default for non-number", () => {
    expect(validateTimeout("abc" as unknown as number)).toBe(
      DEFAULT_TIMEOUT_MS
    );
  });

  it("should clamp values below minimum", () => {
    expect(validateTimeout(100)).toBe(MIN_TIMEOUT_MS);
  });

  it("should clamp values above maximum", () => {
    expect(validateTimeout(600_000)).toBe(MAX_TIMEOUT_MS);
  });
});

describe("createTimeoutSignal", () => {
  it("should create a signal that aborts after timeout", async () => {
    const { signal, clear } = createTimeoutSignal(100);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(signal.aborted).toBe(true);
    clear();
  });

  it("should combine with existing signal", async () => {
    const existingController = new AbortController();
    const { signal, clear } = createTimeoutSignal(
      1000,
      existingController.signal
    );

    existingController.abort(new Error("Cancelled"));

    expect(signal.aborted).toBe(true);
    clear();
  });

  it("should clean up timeout on clear", async () => {
    const { signal, clear } = createTimeoutSignal(1000);
    clear();

    expect(signal.aborted).toBe(false);
  });
});

describe("withTimeout", () => {
  it("should return result when operation completes in time", async () => {
    const result = await withTimeout(async () => "success", {
      timeoutMs: 1000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.value).toBe("success");
    expect(result.error).toBeUndefined();
  });

  it("should time out when operation takes too long", async () => {
    const result = await withTimeout(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return "too late";
      },
      { timeoutMs: 100 }
    );

    expect(result.timedOut).toBe(true);
    expect(result.value).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain("timed out");
  });

  it("should capture operation errors", async () => {
    const result = await withTimeout(
      async () => {
        throw new Error("Provider error");
      },
      { timeoutMs: 1000 }
    );

    expect(result.timedOut).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.error!.message).toBe("Provider error");
  });

  it("should report duration", async () => {
    const result = await withTimeout(async () => "done", { timeoutMs: 1000 });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should use custom error message", async () => {
    const result = await withTimeout(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return "too late";
      },
      { timeoutMs: 100, errorMessage: "Custom timeout message" }
    );

    expect(result.timedOut).toBe(true);
    expect(result.error!.message).toBe("Custom timeout message");
  });
});

describe("formatDuration", () => {
  it("should format milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  it("should format seconds", () => {
    expect(formatDuration(1500)).toBe("1.50s");
  });

  it("should format exact seconds", () => {
    expect(formatDuration(2000)).toBe("2.00s");
  });
});
