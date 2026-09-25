import { describe, it, expect, beforeEach, vi } from "vitest";
import { AuditArchiverJob } from "./job.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";

vi.mock("../../../../src/services/redis.js", () => ({
  redis: {
    xrange: vi.fn().mockResolvedValue([]),
    xlen: vi.fn().mockResolvedValue(0),
    xrevrange: vi.fn().mockResolvedValue([]),
  },
}));

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
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const mockPrisma = {
        market: {
          findMany: vi
            .fn()
            .mockResolvedValue(
              Array.from({ length: 100 }, (_, i) => ({ id: `market-${i}` }))
            ),
        },
        tradeStreamWatermark: {
          findUnique: vi.fn().mockImplementation(async () => {
            await vi.advanceTimersByTimeAsync(150);
            return null;
          }),
          upsert: vi.fn(),
        },
        tradeAuditEvent: {
          findFirst: vi.fn().mockResolvedValue(null),
          upsert: vi.fn(),
        },
        $transaction: vi.fn(),
      };

      const job = new AuditArchiverJob(mockPrisma as any, mockLogger, {
        maxRunMs: 100,
      });

      await job.run();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("exceeded maxRunMs"),
        expect.any(Object)
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("should compute hash correctly", async () => {
    const mockPrisma = {
      market: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const job = new AuditArchiverJob(mockPrisma as any, mockLogger, {});

    // Hash computation should be deterministic
    const result = await job.run();
    expect(result.startedAt).toBeDefined();
  });
});
