import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExpiryJob } from "./job.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";

const mockLogger: ILogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("ExpiryJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return empty results when no expired markets exist", async () => {
    const mockPrisma = {
      market: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn(),
    };

    const job = new ExpiryJob(mockPrisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.totalCandidates).toBe(0);
    expect(result.expiredCount).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  it("should handle database errors gracefully", async () => {
    const mockPrisma = {
      market: {
        findMany: vi
          .fn()
          .mockRejectedValue(new Error("Database connection error")),
      },
    };

    const job = new ExpiryJob(mockPrisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.totalCandidates).toBe(0);
    expect(result.expiredCount).toBe(0);
    expect(result.erroredCount).toBe(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("should respect maxRunMs timeout", async () => {
    const candidates = Array.from({ length: 100 }, (_, i) => ({
      id: `market-${i}`,
      endTime: new Date(Date.now() - 1000),
    }));

    const mockPrisma = {
      market: {
        findMany: vi.fn().mockResolvedValue(candidates),
      },
      $transaction: vi.fn().mockImplementation(async (fn) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error("Market not eligible");
      }),
    };

    const job = new ExpiryJob(mockPrisma as any, mockLogger, {
      maxRunMs: 100,
    });
    const result = await job.run();

    expect(result.candidates.length).toBeLessThan(candidates.length);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("exceeded maxRunMs"),
      expect.any(Object)
    );
  });
});
