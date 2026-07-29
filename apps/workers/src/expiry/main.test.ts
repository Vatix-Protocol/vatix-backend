import { describe, it, expect, vi } from "vitest";
import { loadExpiryConfig } from "./config.js";

describe("Expiry worker config", () => {
  it("should load default configuration", () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv };
    delete process.env.EXPIRY_WORKER_INTERVAL_MS;
    delete process.env.EXPIRY_WORKER_MAX_RUN_MS;
    delete process.env.LOG_LEVEL;

    const config = loadExpiryConfig();

    expect(config.intervalMs).toBe(60000);
    expect(config.maxRunMs).toBe(30000);
    expect(config.logLevel).toBe("info");

    process.env = originalEnv;
  });

  it("should load custom configuration from environment", () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      EXPIRY_WORKER_INTERVAL_MS: "120000",
      EXPIRY_WORKER_MAX_RUN_MS: "60000",
      LOG_LEVEL: "debug",
    };

    const config = loadExpiryConfig();

    expect(config.intervalMs).toBe(120000);
    expect(config.maxRunMs).toBe(60000);
    expect(config.logLevel).toBe("debug");

    process.env = originalEnv;
  });

  it("should throw on invalid interval", () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv, EXPIRY_WORKER_INTERVAL_MS: "500" };

    expect(() => loadExpiryConfig()).toThrow(
      /EXPIRY_WORKER_INTERVAL_MS must be >= 1000/
    );

    process.env = originalEnv;
  });

  it("should throw on invalid maxRunMs", () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv, EXPIRY_WORKER_MAX_RUN_MS: "-1" };

    expect(() => loadExpiryConfig()).toThrow(
      /EXPIRY_WORKER_MAX_RUN_MS must be >= 0/
    );

    process.env = originalEnv;
  });
});
