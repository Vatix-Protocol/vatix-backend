import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isTransientError,
  withRetry,
  RetryValidationError,
  jitteredBackoffMs,
  classifyError,
} from "./retry.js";
import { ResolutionParseError, TradeParseError } from "./types.js";

afterEach(() => vi.restoreAllMocks());

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

// ─── classifyError ───────────────────────────────────────────────────────────
//
// Gap this covers: previously the only classification was a boolean
// (isTransientError), with no distinction between "safe to retry
// immediately" (network blip, 5xx), "safe to retry but back off harder"
// (429), and "never retry" (parse/validation errors). A parse error
// re-thrown by a transport wrapper with a network-looking `.code`, or an
// HTTP 429/5xx from the Stellar RPC, had no correct classification path.
// These tests fail against the pre-fix module, which has no classifyError.

describe("classifyError", () => {
  it("classifies a 429 response as rate_limited", () => {
    const err = Object.assign(new Error("Too Many Requests"), {
      response: { status: 429 },
    });
    expect(classifyError(err)).toBe("rate_limited");
  });

  it("classifies a bare status: 429 error as rate_limited", () => {
    expect(classifyError({ status: 429 })).toBe("rate_limited");
  });

  it("classifies a 500/502/503 response as transient", () => {
    for (const status of [500, 502, 503]) {
      expect(classifyError({ response: { status } })).toBe("transient");
    }
  });

  it("classifies a non-429 4xx response as fatal", () => {
    expect(classifyError({ response: { status: 400 } })).toBe("fatal");
    expect(classifyError({ response: { status: 404 } })).toBe("fatal");
  });

  it("classifies parser errors as fatal even if the message looks network-y", () => {
    const err = new ResolutionParseError("socket hang up", "evt-1");
    expect(classifyError(err)).toBe("fatal");
  });

  it("classifies TradeParseError as fatal", () => {
    expect(classifyError(new TradeParseError("bad payload", "evt-1"))).toBe(
      "fatal"
    );
  });

  it("classifies RetryValidationError as fatal", () => {
    expect(classifyError(new RetryValidationError("bad options"))).toBe(
      "fatal"
    );
  });

  it("classifies known network error codes as transient", () => {
    expect(
      classifyError(Object.assign(new Error("x"), { code: "ECONNRESET" }))
    ).toBe("transient");
  });

  it("classifies unknown errors as fatal", () => {
    expect(classifyError(new Error("bad request"))).toBe("fatal");
    expect(classifyError("not an error")).toBe("fatal");
  });
});

// ─── jitteredBackoffMs ─────────────────────────────────────────────────────────

describe("jitteredBackoffMs", () => {
  it("returns half the exponential delay when Math.random returns 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(jitteredBackoffMs(100, 0)).toBe(50);
    expect(jitteredBackoffMs(100, 2)).toBe(200);
  });

  it("approaches the full exponential delay as Math.random approaches 1", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(jitteredBackoffMs(100, 0)).toBe(100);
    expect(jitteredBackoffMs(100, 2)).toBe(400);
  });

  it("stays within [half, full] of the exponential delay", () => {
    const base = 50;
    for (let attempt = 0; attempt < 5; attempt++) {
      const exponential = base * 2 ** attempt;
      for (let i = 0; i < 20; i++) {
        const delay = jitteredBackoffMs(base, attempt);
        expect(delay).toBeGreaterThanOrEqual(exponential / 2);
        expect(delay).toBeLessThanOrEqual(exponential);
      }
    }
  });

  it("returns 0 for a zero base delay regardless of attempt", () => {
    expect(jitteredBackoffMs(0, 0)).toBe(0);
    expect(jitteredBackoffMs(0, 5)).toBe(0);
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

  it("never retries a parse error, even with retries remaining", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new ResolutionParseError("bad payload", "evt-1"));

    await expect(
      withRetry(fn, { maxRetries: 5, retryDelayMs: 0 })
    ).rejects.toBeInstanceOf(ResolutionParseError);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 with a longer backoff than a plain transient error", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const rateLimited = { response: { status: 429 } };
    const fn = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValue("ok");

    const onRetry = vi.fn();
    const result = await withRetry(fn, {
      maxRetries: 1,
      retryDelayMs: 100,
      onRetry,
    });

    expect(result).toBe("ok");
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ classification: "rate_limited", delayMs: 200 })
    );
  });

  it("honors a Retry-After header on a 429 instead of computing backoff", async () => {
    const rateLimited = {
      response: { status: 429, headers: { "retry-after": "2" } },
    };
    const fn = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValue("ok");
    const onRetry = vi.fn();

    await withRetry(fn, { maxRetries: 1, retryDelayMs: 100, onRetry });

    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ classification: "rate_limited", delayMs: 2000 })
    );
  });

  it("retries a 503 as a plain transient failure", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValue("ok");

    await expect(
      withRetry(fn, { maxRetries: 1, retryDelayMs: 0 })
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-429 4xx response", async () => {
    const fn = vi.fn().mockRejectedValue({ response: { status: 400 } });

    await expect(
      withRetry(fn, { maxRetries: 3, retryDelayMs: 0 })
    ).rejects.toMatchObject({ response: { status: 400 } });
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
