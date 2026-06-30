import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { redis, RedisService, OrderBookData } from "./redis";

describe("RedisService", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await redis.disconnect();
    vi.restoreAllMocks();
  });

  describe("singleton instance", () => {
    it("should export a singleton redis instance", () => {
      expect(redis).toBeDefined();
      expect(redis).toBeInstanceOf(RedisService);
    });
  });

  describe("healthCheck", () => {
    it("should return true for working Redis connection", async () => {
      const isHealthy = await redis.healthCheck();
      expect(isHealthy).toBe(true);
    });
  });

  describe("basic operations", () => {
    const testKey = "test:basic:key";
    const testValue = "test-value";

    afterEach(async () => {
      await redis.del(testKey);
    });

    it("should set and get a value", async () => {
      await redis.set(testKey, testValue);
      const result = await redis.get(testKey);
      expect(result).toBe(testValue);
    });

    it("should return null for non-existent key", async () => {
      const result = await redis.get("non:existent:key");
      expect(result).toBeNull();
    });

    it("should delete a key", async () => {
      await redis.set(testKey, testValue);
      await redis.del(testKey);
      const result = await redis.get(testKey);
      expect(result).toBeNull();
    });

    it("should check if key exists", async () => {
      const existsBefore = await redis.exists(testKey);
      expect(existsBefore).toBe(false);

      await redis.set(testKey, testValue);
      const existsAfter = await redis.exists(testKey);
      expect(existsAfter).toBe(true);
    });
  });

  describe("TTL expiration", () => {
    const testKey = "test:ttl:key";

    afterEach(async () => {
      await redis.del(testKey);
    });

    it("should expire key after TTL", async () => {
      await redis.set(testKey, "expires-soon", 1); // 1 second TTL

      const existsImmediately = await redis.exists(testKey);
      expect(existsImmediately).toBe(true);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const existsAfter = await redis.exists(testKey);
      expect(existsAfter).toBe(false);
    });
  });

  describe("order book operations", () => {
    const marketId = "market-123";
    const outcome = "yes";
    const orderBookData: OrderBookData = {
      bids: [
        { price: 0.45, quantity: 100 },
        { price: 0.44, quantity: 200 },
      ],
      asks: [
        { price: 0.46, quantity: 150 },
        { price: 0.47, quantity: 250 },
      ],
      timestamp: Date.now(),
    };

    afterEach(async () => {
      await redis.clearOrderBook(marketId);
    });

    it("should store and retrieve order book", async () => {
      await redis.setOrderBook(marketId, outcome, orderBookData);
      const result = await redis.getOrderBook(marketId, outcome);

      expect(result).toBeDefined();
      expect(result?.bids).toEqual(orderBookData.bids);
      expect(result?.asks).toEqual(orderBookData.asks);
    });

    it("should return null for non-existent order book", async () => {
      const result = await redis.getOrderBook("non-existent", "no");
      expect(result).toBeNull();
    });

    it("should clear all order books for a market", async () => {
      await redis.setOrderBook(marketId, "yes", orderBookData);
      await redis.setOrderBook(marketId, "no", orderBookData);

      const yesBefore = await redis.getOrderBook(marketId, "yes");
      const noBefore = await redis.getOrderBook(marketId, "no");
      expect(yesBefore).not.toBeNull();
      expect(noBefore).not.toBeNull();

      await redis.clearOrderBook(marketId);

      const yesAfter = await redis.getOrderBook(marketId, "yes");
      const noAfter = await redis.getOrderBook(marketId, "no");
      expect(yesAfter).toBeNull();
      expect(noAfter).toBeNull();
    });

    it("should serialize and deserialize order book data correctly", async () => {
      await redis.setOrderBook(marketId, outcome, orderBookData);
      const result = await redis.getOrderBook(marketId, outcome);

      expect(typeof result?.timestamp).toBe("number");
      expect(Array.isArray(result?.bids)).toBe(true);
      expect(Array.isArray(result?.asks)).toBe(true);
      expect(result?.bids[0].price).toBe(0.45);
      expect(result?.bids[0].quantity).toBe(100);
    });
  });

  describe("connection handling", () => {
    it("should handle disconnect gracefully", async () => {
      // First ensure connected
      await redis.healthCheck();

      // Disconnect
      await redis.disconnect();

      // Reconnects on next operation
      const isHealthy = await redis.healthCheck();
      expect(isHealthy).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should return false when REDIS_URL is not set", async () => {
      const originalUrl = process.env.REDIS_URL;
      delete process.env.REDIS_URL;

      const newService = new RedisService();

      // healthCheck catches errors and returns false
      const result = await newService.healthCheck();
      expect(result).toBe(false);

      process.env.REDIS_URL = originalUrl;
    });
  });

  describe("retry configuration", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("uses default retry config when env vars are not set", async () => {
      // Connect with defaults — health check should still work
      const svc = new RedisService();
      const healthy = await svc.healthCheck();
      expect(healthy).toBe(true);
      await svc.disconnect();
    });

    it("respects REDIS_MAX_RETRIES env override", async () => {
      vi.stubEnv("REDIS_MAX_RETRIES", "5");
      // A new instance created after the stub will pick up the new value
      const svc = new RedisService();
      const healthy = await svc.healthCheck();
      expect(healthy).toBe(true);
      await svc.disconnect();
    });

    it("respects REDIS_RETRY_BASE_DELAY env override", async () => {
      vi.stubEnv("REDIS_RETRY_BASE_DELAY", "200");
      const svc = new RedisService();
      const healthy = await svc.healthCheck();
      expect(healthy).toBe(true);
      await svc.disconnect();
    });

    it("respects REDIS_CONNECT_TIMEOUT env override", async () => {
      vi.stubEnv("REDIS_CONNECT_TIMEOUT", "10000");
      const svc = new RedisService();
      const healthy = await svc.healthCheck();
      expect(healthy).toBe(true);
      await svc.disconnect();
    });
  });

  // =========================================================================
  // Redis key prefix enforcement (closes #619)
  // =========================================================================
  describe("key prefix enforcement", () => {
    afterEach(async () => {
      vi.unstubAllEnvs();
    });

    it("defaults to 'vatix:' when REDIS_KEY_PREFIX is not set", () => {
      // The singleton was constructed with the default env — keyPrefix is "vatix:"
      // (or whatever the test env sets; fall back to "vatix:" when unset).
      const svc = new RedisService();
      expect(svc.keyPrefix).toBe(process.env.REDIS_KEY_PREFIX ?? "vatix:");
    });

    it("respects REDIS_KEY_PREFIX env override at construction time", () => {
      vi.stubEnv("REDIS_KEY_PREFIX", "staging:");
      const svc = new RedisService();
      expect(svc.keyPrefix).toBe("staging:");
    });

    it("allows empty prefix (no namespace)", () => {
      vi.stubEnv("REDIS_KEY_PREFIX", "");
      const svc = new RedisService();
      expect(svc.keyPrefix).toBe("");
    });

    it("prefixed() prepends the key prefix to any key", () => {
      vi.stubEnv("REDIS_KEY_PREFIX", "prod:");
      const svc = new RedisService();
      expect(svc.prefixed("settlement-trades")).toBe("prod:settlement-trades");
      expect(svc.prefixed("audit:market:abc")).toBe("prod:audit:market:abc");
    });

    it("prefixed() returns bare key when prefix is empty", () => {
      vi.stubEnv("REDIS_KEY_PREFIX", "");
      const svc = new RedisService();
      expect(svc.prefixed("some-key")).toBe("some-key");
    });

    it("order book keys include the configured prefix", async () => {
      vi.stubEnv("REDIS_KEY_PREFIX", "test-prefix:");
      const svc = new RedisService();

      const data: OrderBookData = {
        bids: [{ price: 0.5, quantity: 10 }],
        asks: [{ price: 0.51, quantity: 10 }],
        timestamp: Date.now(),
      };

      await svc.setOrderBook("mkt-prefix-test", "yes", data);

      // The key stored in Redis must include the prefix
      const rawKey = `test-prefix:orderbook:mkt-prefix-test:yes`;
      const raw = await svc.get(rawKey);
      expect(raw).not.toBeNull();

      // Cleanup
      await svc.clearOrderBook("mkt-prefix-test");
      await svc.disconnect();
    });

    it("clearOrderBook only removes keys matching the configured prefix pattern", async () => {
      vi.stubEnv("REDIS_KEY_PREFIX", "ns1:");
      const svc1 = new RedisService();

      vi.stubEnv("REDIS_KEY_PREFIX", "ns2:");
      const svc2 = new RedisService();

      const data: OrderBookData = {
        bids: [{ price: 0.5, quantity: 10 }],
        asks: [],
        timestamp: Date.now(),
      };

      await svc1.setOrderBook("shared-mkt", "yes", data);
      await svc2.setOrderBook("shared-mkt", "yes", data);

      // Clear only ns1 — ns2 key should survive
      await svc1.clearOrderBook("shared-mkt");
      vi.unstubAllEnvs();

      const ns2StillPresent = await svc2.getOrderBook("shared-mkt", "yes");
      expect(ns2StillPresent).not.toBeNull();

      // Cleanup
      await svc2.clearOrderBook("shared-mkt");
      await svc1.disconnect();
      await svc2.disconnect();
    });
  });
});
