import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadAuditArchiverConfig,
  MAX_BATCH_SIZE,
  MAX_RUN_MS,
} from "./config.js";

const CONFIG_ENV_KEYS = [
  "AUDIT_ARCHIVER_INTERVAL_MS",
  "AUDIT_ARCHIVER_MAX_RUN_MS",
  "AUDIT_ARCHIVER_BATCH_SIZE",
  "LOG_LEVEL",
] as const;

describe("loadAuditArchiverConfig", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of CONFIG_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CONFIG_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("applies documented defaults", () => {
    expect(loadAuditArchiverConfig()).toEqual({
      intervalMs: 30_000,
      maxRunMs: 20_000,
      batchSize: 1_000,
      logLevel: "info",
    });
  });

  it("rejects a non-numeric value instead of accepting a numeric prefix", () => {
    // parseInt("1000; DROP TABLE trades") === 1000. The archiver controls
    // trade-audit retention, so a malformed value must fail closed.
    process.env.AUDIT_ARCHIVER_BATCH_SIZE = "1000; DROP TABLE trades";
    expect(() => loadAuditArchiverConfig()).toThrow(
      /AUDIT_ARCHIVER_BATCH_SIZE must be an integer/
    );
  });

  it.each(["", "   ", "abc", "1e3", "10.5", "0x10"])(
    "rejects malformed batch size %j",
    (value) => {
      process.env.AUDIT_ARCHIVER_BATCH_SIZE = value;
      expect(() => loadAuditArchiverConfig()).toThrow();
    }
  );

  it("rejects a batch size above the memory-safety ceiling", () => {
    process.env.AUDIT_ARCHIVER_BATCH_SIZE = String(MAX_BATCH_SIZE + 1);
    expect(() => loadAuditArchiverConfig()).toThrow(
      /AUDIT_ARCHIVER_BATCH_SIZE must be <=/
    );
  });

  it("rejects a maxRunMs above the ceiling", () => {
    process.env.AUDIT_ARCHIVER_MAX_RUN_MS = String(MAX_RUN_MS + 1);
    expect(() => loadAuditArchiverConfig()).toThrow(
      /AUDIT_ARCHIVER_MAX_RUN_MS must be <=/
    );
  });

  it("rejects an interval shorter than the run budget", () => {
    // Otherwise every run overruns its own interval and the worker never idles.
    process.env.AUDIT_ARCHIVER_INTERVAL_MS = "1000";
    process.env.AUDIT_ARCHIVER_MAX_RUN_MS = "20000";
    expect(() => loadAuditArchiverConfig()).toThrow(
      /must be >= AUDIT_ARCHIVER_MAX_RUN_MS/
    );
  });

  it("accepts an interval equal to the run budget", () => {
    process.env.AUDIT_ARCHIVER_INTERVAL_MS = "20000";
    process.env.AUDIT_ARCHIVER_MAX_RUN_MS = "20000";
    expect(loadAuditArchiverConfig().intervalMs).toBe(20_000);
  });

  it("accepts maxRunMs = 0 as an explicitly unbounded budget", () => {
    process.env.AUDIT_ARCHIVER_MAX_RUN_MS = "0";
    expect(loadAuditArchiverConfig().maxRunMs).toBe(0);
  });

  it("rejects an unknown log level", () => {
    process.env.LOG_LEVEL = "verbose";
    expect(() => loadAuditArchiverConfig()).toThrow(/LOG_LEVEL must be one of/);
  });
});
