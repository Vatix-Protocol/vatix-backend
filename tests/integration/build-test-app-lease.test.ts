import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const leaseState = vi.hoisted(() => ({
  isLeader: false,
  start: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
}));

vi.mock("../../src/matching/leader-lease.js", () => ({
  leaderLease: {
    start: leaseState.start,
    release: leaseState.release,
    isLeader: () => leaseState.isLeader,
  },
}));

import { buildTestApp } from "./helpers/build-test-app.js";

const LEASE_ERROR =
  "buildTestApp({ enableLease: true }) could not acquire the matching " +
  "leader lease — is Redis reachable and the lease free?";

describe("buildTestApp enableLease", () => {
  const originalLeaseEnv = process.env.MATCHING_LEASE_ENFORCED;

  beforeEach(() => {
    leaseState.isLeader = false;
    leaseState.start.mockClear();
    leaseState.release.mockClear();
  });

  afterEach(() => {
    if (originalLeaseEnv === undefined) {
      delete process.env.MATCHING_LEASE_ENFORCED;
    } else {
      process.env.MATCHING_LEASE_ENFORCED = originalLeaseEnv;
    }
  });

  it("rejects with the documented error and restores MATCHING_LEASE_ENFORCED when the lease cannot be acquired", async () => {
    process.env.MATCHING_LEASE_ENFORCED = "false";

    await expect(buildTestApp({ plugins: [], enableLease: true })).rejects.toThrow(
      LEASE_ERROR
    );

    expect(process.env.MATCHING_LEASE_ENFORCED).toBe("false");
    expect(leaseState.release).toHaveBeenCalledTimes(1);
  });

  it("restores MATCHING_LEASE_ENFORCED and releases the lease on app.close()", async () => {
    process.env.MATCHING_LEASE_ENFORCED = "false";
    leaseState.isLeader = true;

    const app = await buildTestApp({ plugins: [], enableLease: true });
    expect(process.env.MATCHING_LEASE_ENFORCED).toBe("true");

    await app.close();

    expect(process.env.MATCHING_LEASE_ENFORCED).toBe("false");
    expect(leaseState.release).toHaveBeenCalledTimes(1);
  });
});
