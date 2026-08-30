import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the shared Redis instance every API replica talks to.
const { store } = vi.hoisted(() => ({ store: new Map<string, number>() }));

vi.mock("../../services/redis.js", () => ({
  redis: {
    set: vi.fn(async (key: string, _value: string, ttl?: number) => {
      store.set(key, Date.now() + (ttl ?? 0) * 1000);
    }),
    delIfExists: vi.fn(async (key: string) => {
      const expiresAt = store.get(key);
      if (expiresAt === undefined) return false;
      store.delete(key);
      return expiresAt > Date.now();
    }),
  },
}));

import { issueChallenge, consumeNonce } from "./nonceStore.js";

const ADDRESS = "GADDRESS";

describe("nonceStore", () => {
  beforeEach(() => {
    store.clear();
    vi.useRealTimers();
    delete process.env.CHALLENGE_TTL_SECONDS;
  });

  it("issues a unique nonce with the configured TTL", async () => {
    process.env.CHALLENGE_TTL_SECONDS = "60";
    const first = await issueChallenge(ADDRESS);
    const second = await issueChallenge(ADDRESS);

    expect(first.ttlSeconds).toBe(60);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.expiresAt).toBeGreaterThan(Date.now());
  });

  it("consumes a nonce exactly once — a replay against a second replica fails", async () => {
    const { nonce } = await issueChallenge(ADDRESS);

    await expect(consumeNonce(ADDRESS, nonce)).resolves.toBe(true);
    await expect(consumeNonce(ADDRESS, nonce)).resolves.toBe(false);
  });

  it("rejects a nonce issued for a different address", async () => {
    const { nonce } = await issueChallenge(ADDRESS);

    await expect(consumeNonce("GOTHER", nonce)).resolves.toBe(false);
  });

  it("rejects an unknown nonce", async () => {
    await expect(consumeNonce(ADDRESS, "never-issued")).resolves.toBe(false);
  });

  it("fails closed past the expiry boundary", async () => {
    process.env.CHALLENGE_TTL_SECONDS = "1";
    const { nonce } = await issueChallenge(ADDRESS);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1_001);

    await expect(consumeNonce(ADDRESS, nonce)).resolves.toBe(false);
  });

  it("yields a single winner for a concurrent double-submit", async () => {
    const { nonce } = await issueChallenge(ADDRESS);

    const results = await Promise.all([
      consumeNonce(ADDRESS, nonce),
      consumeNonce(ADDRESS, nonce),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
