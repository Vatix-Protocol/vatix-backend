import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { HorizonCacheService, type HorizonAccountData } from "./horizonCache.js";

const VALID_ACCOUNT = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const INVALID_ACCOUNT = "not-a-stellar-key";

const sampleData: HorizonAccountData = {
  accountId: VALID_ACCOUNT,
  sequence: "123456789",
  balances: [{ asset_type: "native", balance: "100.0000000" }],
  fetchedAt: Date.now(),
};

// Mock redis module so tests run without a live Redis instance
vi.mock("./redis.js", () => {
  const store = new Map<string, string>();
  return {
    redis: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      del: vi.fn(async (key: string) => { store.delete(key); }),
      _store: store, // exposed for test assertions
    },
  };
});

describe("HorizonCacheService", () => {
  let service: HorizonCacheService;

  beforeEach(async () => {
    service = new HorizonCacheService();
    // clear the mock store between tests
    const { redis } = await import("./redis.js");
    (redis as any)._store.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- success path ---

  it("returns null for a cache miss", async () => {
    const result = await service.get(VALID_ACCOUNT);
    expect(result).toBeNull();
  });

  it("stores and retrieves account data", async () => {
    await service.set(VALID_ACCOUNT, sampleData);
    const result = await service.get(VALID_ACCOUNT);
    expect(result).toBeDefined();
    expect(result?.accountId).toBe(VALID_ACCOUNT);
    expect(result?.balances[0].balance).toBe("100.0000000");
  });

  it("invalidates a cached entry", async () => {
    await service.set(VALID_ACCOUNT, sampleData);
    await service.invalidate(VALID_ACCOUNT);
    const result = await service.get(VALID_ACCOUNT);
    expect(result).toBeNull();
  });

  // --- failure / invalid input path ---

  it("returns null and does not call redis.get for an invalid account id", async () => {
    const { redis } = await import("./redis.js");
    const result = await service.get(INVALID_ACCOUNT);
    expect(result).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("silently ignores set for an invalid account id", async () => {
    const { redis } = await import("./redis.js");
    await service.set(INVALID_ACCOUNT, sampleData);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("silently ignores invalidate for an invalid account id", async () => {
    const { redis } = await import("./redis.js");
    await service.invalidate(INVALID_ACCOUNT);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("does not expose raw secrets — fetchedAt is a number, no private keys", async () => {
    await service.set(VALID_ACCOUNT, sampleData);
    const result = await service.get(VALID_ACCOUNT);
    expect(result).not.toHaveProperty("privateKey");
    expect(typeof result?.fetchedAt).toBe("number");
  });
});
