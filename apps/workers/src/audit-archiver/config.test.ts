import { describe, it, expect } from "vitest";
import { loadAuditArchiverConfig } from "./config.js";

/**
 * Retention env is fail-closed: an unset or non-positive value must disable
 * deletes rather than falling back to a guessed window (#1137).
 */
describe("loadAuditArchiverConfig retention (#1137)", () => {
  const base = {
    AUDIT_ARCHIVER_INTERVAL_MS: "30000",
    AUDIT_ARCHIVER_MAX_RUN_MS: "20000",
    AUDIT_ARCHIVER_BATCH_SIZE: "1000",
  };

  const withEnv = (overrides: Record<string, string | undefined>) => {
    const previous: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(overrides)) {
      previous[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return () => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
  };

  it("defaults to retention disabled when unset", () => {
    const restore = withEnv({
      ...base,
      AUDIT_ARCHIVE_RETENTION_DAYS: undefined,
    });
    try {
      const config = loadAuditArchiverConfig();
      expect(config.retentionDays).toBe(0);
      expect(config.retentionBatchSize).toBe(1000);
      expect(config.retentionMinPerMarket).toBe(1);
    } finally {
      restore();
    }
  });

  it("reads an explicit retention window", () => {
    const restore = withEnv({
      ...base,
      AUDIT_ARCHIVE_RETENTION_DAYS: "90",
      AUDIT_ARCHIVE_RETENTION_BATCH_SIZE: "500",
      AUDIT_ARCHIVE_RETENTION_MIN_PER_MARKET: "2",
    });
    try {
      const config = loadAuditArchiverConfig();
      expect(config.retentionDays).toBe(90);
      expect(config.retentionBatchSize).toBe(500);
      expect(config.retentionMinPerMarket).toBe(2);
    } finally {
      restore();
    }
  });

  it("rejects a negative retention window instead of guessing", () => {
    const restore = withEnv({ ...base, AUDIT_ARCHIVE_RETENTION_DAYS: "-1" });
    try {
      expect(() => loadAuditArchiverConfig()).toThrow(
        /AUDIT_ARCHIVE_RETENTION_DAYS/
      );
    } finally {
      restore();
    }
  });

  it("rejects a non-numeric retention window", () => {
    const restore = withEnv({ ...base, AUDIT_ARCHIVE_RETENTION_DAYS: "abc" });
    try {
      expect(() => loadAuditArchiverConfig()).toThrow(
        /AUDIT_ARCHIVE_RETENTION_DAYS/
      );
    } finally {
      restore();
    }
  });

  it("rejects a batch size below 1 so a run cannot be unbounded", () => {
    const restore = withEnv({
      ...base,
      AUDIT_ARCHIVE_RETENTION_DAYS: "30",
      AUDIT_ARCHIVE_RETENTION_BATCH_SIZE: "0",
    });
    try {
      expect(() => loadAuditArchiverConfig()).toThrow(
        /AUDIT_ARCHIVE_RETENTION_BATCH_SIZE/
      );
    } finally {
      restore();
    }
  });

  it("rejects minPerMarket below 1 so a market can never be emptied", () => {
    const restore = withEnv({
      ...base,
      AUDIT_ARCHIVE_RETENTION_DAYS: "30",
      AUDIT_ARCHIVE_RETENTION_MIN_PER_MARKET: "0",
    });
    try {
      expect(() => loadAuditArchiverConfig()).toThrow(
        /AUDIT_ARCHIVE_RETENTION_MIN_PER_MARKET/
      );
    } finally {
      restore();
    }
  });
});
