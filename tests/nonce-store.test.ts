/**
 * Unit tests for nonceStore — atomic consume-after-verify under replica races.
 *
 * Issue #966: Two replicas could accept the same nonce if DEL is not atomic.
 * The fix is already implemented via Redis DEL (which counts removed keys),
 * so these tests act as a regression guard: they fail if the atomicity gap
 * is reintroduced (e.g. by reverting to EXISTS→DEL two-step).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as redisModule from "../src/services/redis.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRedisMock(delIfExistsImpl: (key: string) => Promise<boolean>) {
  return {
    set: vi.fn().mockResolvedValue(undefined),
    delIfExists: vi.fn().mockImplementation(delIfExistsImpl),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("nonceStore: atomic consume-after-verify (issue #966)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("consumeNonce returns true exactly once when the nonce exists", async () => {
    // Simulate Redis DEL semantics: first call removes key (returns true),
    // every subsequent call finds nothing (returns false).
    let deleted = false;
    vi.spyOn(redisModule.redis, "delIfExists").mockImplementation(
      async (_key: string) => {
        if (!deleted) {
          deleted = true;
          return true;
        }
        return false;
      }
    );

    const { consumeNonce } = await import(
      "../src/api/middleware/nonceStore.js"
    );

    const userAddress = "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR";
    const nonce = "test-nonce-abc123";

    const first = await consumeNonce(userAddress, nonce);
    const second = await consumeNonce(userAddress, nonce);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("consumeNonce returns false when nonce was never issued (unknown nonce)", async () => {
    vi.spyOn(redisModule.redis, "delIfExists").mockResolvedValue(false);

    const { consumeNonce } = await import(
      "../src/api/middleware/nonceStore.js"
    );

    const result = await consumeNonce(
      "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR",
      "nonexistent-nonce"
    );
    expect(result).toBe(false);
  });

  it("concurrent replicas racing on the same nonce produce exactly one winner", async () => {
    // Simulate atomic DEL: only one concurrent caller wins.
    let claimed = false;
    vi.spyOn(redisModule.redis, "delIfExists").mockImplementation(
      async (_key: string) => {
        if (!claimed) {
          claimed = true;
          return true;
        }
        return false;
      }
    );

    const { consumeNonce } = await import(
      "../src/api/middleware/nonceStore.js"
    );

    const userAddress = "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR";
    const nonce = "race-nonce-xyz";

    // Fire two "replicas" simultaneously
    const [r1, r2] = await Promise.all([
      consumeNonce(userAddress, nonce),
      consumeNonce(userAddress, nonce),
    ]);

    const winners = [r1, r2].filter(Boolean);
    expect(winners).toHaveLength(1);
  });

  it("issueChallenge stores nonce with the correct TTL", async () => {
    const setSpy = vi
      .spyOn(redisModule.redis, "set")
      .mockResolvedValue(undefined);

    const { issueChallenge } = await import(
      "../src/api/middleware/nonceStore.js"
    );

    const challenge = await issueChallenge(
      "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR"
    );

    // set must be called with a positive TTL (EX argument)
    expect(setSpy).toHaveBeenCalledOnce();
    const [_key, _value, ttl] = setSpy.mock.calls[0];
    expect(typeof ttl).toBe("number");
    expect(ttl as number).toBeGreaterThan(0);

    // Returned object must include the nonce and expiry
    expect(typeof challenge.nonce).toBe("string");
    expect(challenge.nonce.length).toBeGreaterThan(0);
    expect(challenge.expiresAt).toBeGreaterThan(Date.now());
    expect(challenge.ttlSeconds).toBeGreaterThan(0);
  });

  it("consumeNonce uses a Redis DEL (not EXISTS-then-DEL) to stay atomic", async () => {
    // Verify the call path: delIfExists must be used, NOT exists() followed by del()
    const delIfExistsSpy = vi
      .spyOn(redisModule.redis, "delIfExists")
      .mockResolvedValue(true);
    const existsSpy = vi.spyOn(redisModule.redis, "exists");
    const delSpy = vi.spyOn(redisModule.redis, "del");

    const { consumeNonce } = await import(
      "../src/api/middleware/nonceStore.js"
    );

    await consumeNonce(
      "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR",
      "atomic-check-nonce"
    );

    // The atomic helper must be used
    expect(delIfExistsSpy).toHaveBeenCalledOnce();
    // The two-step TOCTOU path must NOT be used
    expect(existsSpy).not.toHaveBeenCalled();
    expect(delSpy).not.toHaveBeenCalled();
  });

  it("consumeNonce throws (propagates) when Redis is unavailable — fail closed", async () => {
    vi.spyOn(redisModule.redis, "delIfExists").mockRejectedValue(
      new Error("Redis connection failed")
    );

    const { consumeNonce } = await import(
      "../src/api/middleware/nonceStore.js"
    );

    await expect(
      consumeNonce(
        "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR",
        "some-nonce"
      )
    ).rejects.toThrow("Redis connection failed");
  });
});
