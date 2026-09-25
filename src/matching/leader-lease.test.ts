import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Fake Redis lease store — reimplements the exact CAS semantics of the real
// Lua scripts in src/services/redis.ts (acquireOrRenewLease /
// releaseLeaseIfHeld) in plain JS, driven by the fake system clock (Date.now)
// installed via vi.useFakeTimers/vi.setSystemTime. This lets tests simulate
// dual contenders and TTL expiry deterministically without a real Redis.
// ---------------------------------------------------------------------------
function createFakeLeaseStore() {
  let lockVal: string | null = null;
  let expiresAt = 0;
  let fencingCounter = 0;

  return {
    async acquireOrRenewLease(
      _lockKey: string,
      _fencingKey: string,
      holderId: string,
      ttlMs: number,
      knownToken: number
    ): Promise<number> {
      const now = Date.now();
      if (lockVal !== null && now >= expiresAt) {
        lockVal = null; // Redis would have expired the key by now
      }
      if (lockVal === null) {
        fencingCounter += 1;
        lockVal = `${holderId}:${fencingCounter}`;
        expiresAt = now + ttlMs;
        return fencingCounter;
      }
      if (lockVal === `${holderId}:${knownToken}`) {
        expiresAt = now + ttlMs;
        return knownToken;
      }
      return -1;
    },

    async releaseLeaseIfHeld(
      _lockKey: string,
      holderId: string,
      token: number
    ): Promise<boolean> {
      if (lockVal === `${holderId}:${token}`) {
        lockVal = null;
        return true;
      }
      return false;
    },

    // Test helper: who currently holds the lock, per the fake store.
    peek(): string | null {
      return Date.now() >= expiresAt ? null : lockVal;
    },
  };
}

const redisMock = vi.hoisted(() => ({
  acquireOrRenewLease: vi.fn(),
  releaseLeaseIfHeld: vi.fn(),
}));
vi.mock("../services/redis.js", () => ({ redis: redisMock }));

import { LeaderLease } from "./leader-lease.js";
import { matchingLeaderGauge } from "../services/metrics.js";

const TTL_MS = 1000;
const RENEW_INTERVAL_MS = 300;

function newLease(): LeaderLease {
  vi.stubEnv("MATCHING_LEASE_TTL_MS", String(TTL_MS));
  vi.stubEnv("MATCHING_LEASE_RENEW_INTERVAL_MS", String(RENEW_INTERVAL_MS));
  return new LeaderLease();
}

describe("LeaderLease", () => {
  let store: ReturnType<typeof createFakeLeaseStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    store = createFakeLeaseStore();
    redisMock.acquireOrRenewLease.mockImplementation(store.acquireOrRenewLease);
    redisMock.releaseLeaseIfHeld.mockImplementation(store.releaseLeaseIfHeld);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("is not leader before start() is called", () => {
    const lease = newLease();
    expect(lease.isLeader()).toBe(false);
    expect(lease.getToken()).toBeNull();
  });

  it("acquires the lease on the first tick and fires onAcquired with the fencing token", async () => {
    const lease = newLease();
    const onAcquired = vi.fn();

    await lease.start({ onAcquired });

    expect(lease.isLeader()).toBe(true);
    expect(lease.getToken()).toBe(1);
    expect(onAcquired).toHaveBeenCalledExactlyOnceWith(1);
    expect((await matchingLeaderGauge.get()).values[0]?.value).toBe(1);
  });

  it("renews on heartbeat, keeping the same fencing token and firing onAcquired only once", async () => {
    const lease = newLease();
    const onAcquired = vi.fn();
    await lease.start({ onAcquired });

    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS * 3);

    expect(lease.isLeader()).toBe(true);
    expect(lease.getToken()).toBe(1); // renewal reuses the token, doesn't mint a new one
    expect(onAcquired).toHaveBeenCalledTimes(1);
    // Initial acquire + at least a couple of heartbeats; every renewal call
    // must have reused the same token (never minted a new one mid-lease).
    expect(
      redisMock.acquireOrRenewLease.mock.calls.length
    ).toBeGreaterThanOrEqual(3);
    for (const call of redisMock.acquireOrRenewLease.mock.calls.slice(1)) {
      expect(call[4]).toBe(1); // knownToken argument on every renewal
    }
  });

  it("fails closed the instant the local lease deadline passes, even without another tick", async () => {
    const lease = newLease();
    await lease.start();
    expect(lease.isLeader()).toBe(true);

    // Jump the clock past the TTL without letting any heartbeat run — this
    // is what protects the write path (placeOrder) even if the process is
    // paused/partitioned and never gets to run its next scheduled renewal.
    vi.setSystemTime(TTL_MS + 1);

    expect(lease.isLeader()).toBe(false);
    expect(lease.getToken()).toBeNull();
  });

  it("loses the lease and invalidates state when another instance has taken over, firing onLost", async () => {
    const lease = newLease();
    const onLost = vi.fn();
    await lease.start({ onLost });
    expect(lease.isLeader()).toBe(true);

    // Simulate a rival instance stealing the lock directly in the store
    // (e.g. because our own renewal was slow enough for the TTL to lapse).
    redisMock.acquireOrRenewLease.mockResolvedValueOnce(-1);
    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);

    expect(lease.isLeader()).toBe(false);
    expect(onLost).toHaveBeenCalledExactlyOnceWith(
      "lease is held by another instance"
    );
    expect((await matchingLeaderGauge.get()).values[0]?.value).toBe(0);
  });

  it("does not demote on a transient Redis error alone, but still fails closed once the TTL elapses", async () => {
    const lease = newLease();
    const onLost = vi.fn();
    await lease.start({ onLost });
    expect(lease.isLeader()).toBe(true);

    redisMock.acquireOrRenewLease.mockRejectedValue(new Error("ECONNREFUSED"));

    // Still well within TTL — a single failed heartbeat must not flip us to
    // non-leader immediately (that would cause needless handovers on blips).
    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);
    expect(lease.isLeader()).toBe(true);
    expect(onLost).not.toHaveBeenCalled();

    // Once the TTL has actually elapsed while Redis stayed unreachable,
    // the next tick's local-deadline check fails us closed regardless.
    await vi.advanceTimersByTimeAsync(TTL_MS);
    expect(lease.isLeader()).toBe(false);
    expect(onLost).toHaveBeenCalledWith(
      "local lease deadline passed before renewal succeeded"
    );
  });

  it("dual contenders: only one of two instances competing for the same lock becomes leader", async () => {
    const leaseA = newLease();
    const leaseB = newLease();

    await Promise.all([leaseA.start(), leaseB.start()]);

    expect([leaseA.isLeader(), leaseB.isLeader()].filter(Boolean)).toHaveLength(
      1
    );
  });

  it("fences a stale token: the old leader cannot renew once a new leader has acquired a higher token", async () => {
    const leaseA = newLease();
    const onLostA = vi.fn();
    await leaseA.start({ onLost: onLostA });
    expect(leaseA.isLeader()).toBe(true);
    const staleToken = leaseA.getToken();

    // A goes silent (network partition — stop calling tick for A entirely)
    // long enough for its lease to expire in the store, then B acquires.
    vi.setSystemTime(TTL_MS + 1);
    const leaseB = newLease();
    await leaseB.start();

    expect(leaseB.isLeader()).toBe(true);
    expect(leaseB.getToken()).toBeGreaterThan(staleToken!);

    // A's own local clock check already fences it off without needing to
    // reach Redis at all — this is what bounds a partitioned leader's
    // ability to keep enqueueing fills after losing ownership.
    expect(leaseA.isLeader()).toBe(false);
  });

  it("release() deletes the lease only if still held, allowing immediate takeover instead of waiting out the TTL", async () => {
    const lease = newLease();
    await lease.start();
    expect(store.peek()).not.toBeNull();

    await lease.release();

    expect(store.peek()).toBeNull();
    expect(lease.isLeader()).toBe(false);
    expect((await matchingLeaderGauge.get()).values[0]?.value).toBe(0);
  });

  it("release() is a no-op against the store when this instance never held the lease", async () => {
    const lease = newLease();
    // Never started/acquired.
    await lease.release();
    expect(redisMock.releaseLeaseIfHeld).not.toHaveBeenCalled();
  });
});
