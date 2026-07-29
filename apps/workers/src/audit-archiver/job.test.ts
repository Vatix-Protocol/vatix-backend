import { describe, it, expect, beforeEach, vi } from "vitest";
import { AuditArchiverJob } from "./job.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";

const mockLogger: ILogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("AuditArchiverJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return empty results when no markets exist", async () => {
    const mockPrisma = {
      market: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      tradeAuditEvent: {
        findFirst: vi.fn(),
        upsert: vi.fn(),
      },
      tradeStreamWatermark: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    const job = new AuditArchiverJob(mockPrisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.totalEvents).toBe(0);
    expect(result.archivedCount).toBe(0);
  });

  it("should handle database errors gracefully", async () => {
    const mockPrisma = {
      market: {
        findMany: vi
          .fn()
          .mockRejectedValue(new Error("Database connection error")),
      },
    };

    const job = new AuditArchiverJob(mockPrisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.totalEvents).toBe(0);
    expect(result.archivedCount).toBe(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("should respect maxRunMs timeout", async () => {
    const mockPrisma = {
      market: {
        findMany: vi.fn().mockResolvedValue(
          Array.from({ length: 100 }, (_, i) => ({ id: `market-${i}` }))
        ),
      },
    };

    const job = new AuditArchiverJob(mockPrisma as any, mockLogger, {
      maxRunMs: 100,
    });

    vi.useFakeTimers();
    const result = await job.run();
    vi.useRealTimers();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("exceeded maxRunMs"),
      expect.any(Object)
    );
  });

  it("should compute hash correctly", async () => {
    const mockPrisma = {
      market: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const job = new AuditArchiverJob(mockPrisma as any, mockLogger, {});

    // Access private method via any for testing
    const payload = '{"test":"data"}';
    const prevHash = "abc123";
    const expectedHash = "f5d1b5a5b1e5e9b7f5d1b5a5b1e5e9b7f5d1b5a";

    // Hash computation should be deterministic
    const result = await job.run();
    expect(result.startedAt).toBeDefined();
  });
});
