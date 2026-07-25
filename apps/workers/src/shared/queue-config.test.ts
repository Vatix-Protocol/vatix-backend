import { describe, it, expect, afterEach } from "vitest";
import { DEFAULT_JOB_OPTIONS, redisConnectionFromEnv } from "./queue-config.js";

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

  describe("redisConnectionFromEnv", () => {
    const originalRedisUrl = process.env.REDIS_URL;

    afterEach(() => {
      if (originalRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = originalRedisUrl;
      }
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
