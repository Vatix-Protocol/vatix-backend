import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_JOB_OPTIONS,
  SETTLEMENT_JOB_OPTIONS,
  ORACLE_SUBMISSION_JOB_OPTIONS,
  redisConnectionFromEnv,
  settlementQueueName,
  submissionQueueName,
} from "./queue-config.js";

// Regression coverage for #764: `bullmq` was used throughout apps/workers
// (this module, the settlement consumer, and the oracle submission queue)
// without ever being declared as a dependency in package.json. A clean
// `pnpm install` silently dropped it from node_modules, breaking the
// settlement and oracle-submission workers at startup with
// "Cannot find module 'bullmq'". Importing it here fails the same way if
// the dependency ever goes undeclared again.
describe("queue-config", () => {
  it("resolves bullmq's JobsOptions type and exposes unified retry/backoff/DLQ defaults", () => {
    expect(DEFAULT_JOB_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: false,
    });
  });

  // Regression coverage: oracle submissions and settlement previously shared
  // a single DEFAULT_JOB_OPTIONS, so a backoff tuned for settlement (slow,
  // few retries) also throttled oracle resolution submissions, and a backoff
  // tuned for oracle (fast, many retries) would have hammered settlement on
  // failure. They must diverge and DEFAULT_JOB_OPTIONS must stay aliased to
  // settlement for existing callers that haven't migrated.
  it("gives settlement and oracle submission queues distinct backoff/attempts", () => {
    expect(SETTLEMENT_JOB_OPTIONS).toEqual(DEFAULT_JOB_OPTIONS);
    expect(ORACLE_SUBMISSION_JOB_OPTIONS).not.toEqual(SETTLEMENT_JOB_OPTIONS);
    expect(ORACLE_SUBMISSION_JOB_OPTIONS.attempts).toBeGreaterThan(
      SETTLEMENT_JOB_OPTIONS.attempts as number
    );
    expect(
      (ORACLE_SUBMISSION_JOB_OPTIONS.backoff as { delay: number }).delay
    ).toBeLessThan((SETTLEMENT_JOB_OPTIONS.backoff as { delay: number }).delay);
  });

  describe("settlementQueueName", () => {
    const originalSettlementName = process.env.SETTLEMENT_QUEUE_NAME;
    const originalKeyPrefix = process.env.REDIS_KEY_PREFIX;

    afterEach(() => {
      if (originalSettlementName === undefined) {
        delete process.env.SETTLEMENT_QUEUE_NAME;
      } else {
        process.env.SETTLEMENT_QUEUE_NAME = originalSettlementName;
      }
      if (originalKeyPrefix === undefined) {
        delete process.env.REDIS_KEY_PREFIX;
      } else {
        process.env.REDIS_KEY_PREFIX = originalKeyPrefix;
      }
    });

    it("returns the default prefixed queue name when env vars are unset", () => {
      delete process.env.SETTLEMENT_QUEUE_NAME;
      delete process.env.REDIS_KEY_PREFIX;
      expect(settlementQueueName()).toBe("vatix:settlement-trades");
    });

    it("uses REDIS_KEY_PREFIX and SETTLEMENT_QUEUE_NAME when both are set", () => {
      process.env.REDIS_KEY_PREFIX = "staging:";
      process.env.SETTLEMENT_QUEUE_NAME = "my-settlement";
      expect(settlementQueueName()).toBe("staging:my-settlement");
    });

    it("uses the default name with a custom prefix", () => {
      process.env.REDIS_KEY_PREFIX = "prod:";
      delete process.env.SETTLEMENT_QUEUE_NAME;
      expect(settlementQueueName()).toBe("prod:settlement-trades");
    });

    it("uses the custom name with the default prefix", () => {
      delete process.env.REDIS_KEY_PREFIX;
      process.env.SETTLEMENT_QUEUE_NAME = "custom-settlement";
      expect(settlementQueueName()).toBe("vatix:custom-settlement");
    });
  });

  describe("submissionQueueName", () => {
    const originalSubmissionName = process.env.SUBMISSION_QUEUE_NAME;

    afterEach(() => {
      if (originalSubmissionName === undefined) {
        delete process.env.SUBMISSION_QUEUE_NAME;
      } else {
        process.env.SUBMISSION_QUEUE_NAME = originalSubmissionName;
      }
    });

    it("returns the default queue name when SUBMISSION_QUEUE_NAME is unset", () => {
      delete process.env.SUBMISSION_QUEUE_NAME;
      expect(submissionQueueName()).toBe("oracle-submissions");
    });

    it("returns SUBMISSION_QUEUE_NAME when set", () => {
      process.env.SUBMISSION_QUEUE_NAME = "custom-oracle-submissions";
      expect(submissionQueueName()).toBe("custom-oracle-submissions");
    });

    it("does not include a key prefix (oracle queue is prefix-free by design)", () => {
      process.env.SUBMISSION_QUEUE_NAME = "oracle-submissions";
      const name = submissionQueueName();
      expect(name).not.toContain(":");
    });
  });

  describe("redisConnectionFromEnv", () => {
    const originalRedisUrl = process.env.REDIS_URL;
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      if (originalRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = originalRedisUrl;
      }
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    // Regression coverage for the gap this issue fixes: silently defaulting
    // to localhost:6379 in production means queue producers "succeed" while
    // enqueuing jobs nobody ever processes, silently dropping trades /
    // resolutions / admin actions.
    it("fails fast when REDIS_URL is unset and NODE_ENV=production", () => {
      delete process.env.REDIS_URL;
      process.env.NODE_ENV = "production";
      expect(() => redisConnectionFromEnv()).toThrow(/REDIS_URL is required/);
    });

    it("still falls back to localhost outside production", () => {
      delete process.env.REDIS_URL;
      process.env.NODE_ENV = "test";
      expect(redisConnectionFromEnv()).toEqual({
        host: "localhost",
        port: 6379,
      });
    });

    it("defaults to localhost:6379 when REDIS_URL is unset", () => {
      delete process.env.REDIS_URL;
      expect(redisConnectionFromEnv()).toEqual({
        host: "localhost",
        port: 6379,
      });
    });

    it("parses host and port from a plain redis:// URL", () => {
      process.env.REDIS_URL = "redis://redis-host:6380";
      expect(redisConnectionFromEnv()).toEqual({
        host: "redis-host",
        port: 6380,
      });
    });

    it("parses password and host/port from an authenticated rediss:// URL", () => {
      process.env.REDIS_URL = "rediss://user:secret@redis-host:6380";
      expect(redisConnectionFromEnv()).toEqual({
        host: "redis-host",
        port: 6380,
        password: "secret",
      });
    });
  });
});
