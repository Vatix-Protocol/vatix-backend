import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_JOB_OPTIONS,
  settlementQueueName,
  submissionQueueName,
  redisConnectionFromEnv,
} from "./queue-config.js";

describe("queue-config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore environment after each test
    process.env = originalEnv;
  });

  describe("DEFAULT_JOB_OPTIONS", () => {
    it("has expected retry and backoff configuration", () => {
      expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3);
      expect(DEFAULT_JOB_OPTIONS.backoff).toEqual({
        type: "exponential",
        delay: 1_000,
      });
      expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toEqual({ count: 100 });
      expect(DEFAULT_JOB_OPTIONS.removeOnFail).toBe(false);
    });
  });

  describe("settlementQueueName", () => {
    it("uses defaults when env vars are not set", () => {
      delete process.env.SETTLEMENT_QUEUE_NAME;
      delete process.env.REDIS_KEY_PREFIX;
      expect(settlementQueueName()).toBe("vatix:settlement-trades");
    });

    it("respects SETTLEMENT_QUEUE_NAME env var", () => {
      process.env.SETTLEMENT_QUEUE_NAME = "custom-settlement";
      process.env.REDIS_KEY_PREFIX = "prefix:";
      expect(settlementQueueName()).toBe("prefix:custom-settlement");
    });

    it("respects REDIS_KEY_PREFIX env var", () => {
      process.env.SETTLEMENT_QUEUE_NAME = "settlement-trades";
      process.env.REDIS_KEY_PREFIX = "myapp:";
      expect(settlementQueueName()).toBe("myapp:settlement-trades");
    });
  });

  describe("submissionQueueName", () => {
    it("uses default when env var is not set", () => {
      delete process.env.SUBMISSION_QUEUE_NAME;
      expect(submissionQueueName()).toBe("oracle-submissions");
    });

    it("respects SUBMISSION_QUEUE_NAME env var", () => {
      process.env.SUBMISSION_QUEUE_NAME = "custom-oracle";
      expect(submissionQueueName()).toBe("custom-oracle");
    });

    it("does not include REDIS_KEY_PREFIX", () => {
      process.env.REDIS_KEY_PREFIX = "should-not-appear:";
      process.env.SUBMISSION_QUEUE_NAME = "oracle-submissions";
      expect(submissionQueueName()).not.toContain("should-not-appear");
    });
  });

  describe("redisConnectionFromEnv", () => {
    it("parses default Redis URL", () => {
      delete process.env.REDIS_URL;
      const config = redisConnectionFromEnv();
      expect(config).toEqual({
        host: "localhost",
        port: 6379,
      });
    });

    it("parses custom Redis URL without auth", () => {
      process.env.REDIS_URL = "redis://redis.example.com:6380";
      const config = redisConnectionFromEnv();
      expect(config).toEqual({
        host: "redis.example.com",
        port: 6380,
      });
    });

    it("parses Redis URL with password", () => {
      process.env.REDIS_URL = "redis://:mypassword@redis.example.com:6380";
      const config = redisConnectionFromEnv();
      expect(config).toEqual({
        host: "redis.example.com",
        port: 6380,
        password: "mypassword",
      });
    });

    it("parses Redis URL with username and password", () => {
      process.env.REDIS_URL = "redis://user:pass@redis.example.com:6380";
      const config = redisConnectionFromEnv();
      expect(config).toEqual({
        host: "redis.example.com",
        port: 6380,
        password: "pass",
      });
    });

    it("handles rediss:// scheme", () => {
      process.env.REDIS_URL = "rediss://:mypassword@redis.example.com:6380";
      const config = redisConnectionFromEnv();
      expect(config).toEqual({
        host: "redis.example.com",
        port: 6380,
        password: "mypassword",
      });
    });
  });

  describe("API and worker integration", () => {
    it("exports are available to both API and workers", () => {
      // Verify all expected exports exist
      expect(DEFAULT_JOB_OPTIONS).toBeDefined();
      expect(typeof settlementQueueName).toBe("function");
      expect(typeof submissionQueueName).toBe("function");
      expect(typeof redisConnectionFromEnv).toBe("function");
    });
  });
});
