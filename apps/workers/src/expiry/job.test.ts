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

  // Regression coverage: a market whose endTime has passed by less than
  // the host/ledger clock skew tolerance must NOT be treated as an expiry
  // candidate. Without this, a host clock that is even a few seconds fast
  // relative to the Stellar ledger's close time causes markets to be
  // cancelled and orders released before the market has actually ended
  // on-chain — a silent, hard-to-reproduce production bug.
  it("does not treat a market as an expiry candidate when it ended within the clock skew tolerance window", async () => {
    // Ends 2s ago — inside a 5s tolerance window, so should NOT expire yet.
    const barelyEndedMarket = {
      id: "market-skew",
      endTime: new Date(Date.now() - 2000),
    };

    const mockPrisma = {
      market: {
        findMany: vi.fn().mockImplementation(({ where }) => {
          const threshold = where.endTime.lte as Date;
          return Promise.resolve(
            barelyEndedMarket.endTime.getTime() <= threshold.getTime()
              ? [barelyEndedMarket]
              : []
          );
        }),
      },
      $transaction: vi.fn(),
    };

    const job = new ExpiryJob(mockPrisma as any, mockLogger, {
      clockSkewToleranceMs: 5000,
    });
    const result = await job.run();

    expect(result.totalCandidates).toBe(0);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("treats a market as an expiry candidate once it has ended beyond the clock skew tolerance", async () => {
    const longEndedMarket = {
      id: "market-skew-2",
      endTime: new Date(Date.now() - 10_000),
    };

    const mockPrisma = {
      market: {
        findMany: vi.fn().mockImplementation(({ where }) => {
          const threshold = where.endTime.lte as Date;
          return Promise.resolve(
            longEndedMarket.endTime.getTime() <= threshold.getTime()
              ? [longEndedMarket]
              : []
          );
        }),
      },
      $transaction: vi.fn().mockRejectedValue(new Error("Market not eligible")),
    };

    const job = new ExpiryJob(mockPrisma as any, mockLogger, {
      clockSkewToleranceMs: 5000,
    });
    const result = await job.run();

    expect(result.totalCandidates).toBe(1);
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
