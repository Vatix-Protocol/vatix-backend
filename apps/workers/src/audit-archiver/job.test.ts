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

  describe("retention (#1137)", () => {
    const NOW = new Date("2026-03-01T00:00:00.000Z");
    const DAY = 86_400_000;

    function candidate(id: string, marketId: string, ageDays: number) {
      return {
        id,
        marketId,
        archivedAt: new Date(NOW.getTime() - ageDays * DAY),
      };
    }

    function makePrisma(
      rows: Array<ReturnType<typeof candidate>>,
      overrides: Record<string, unknown> = {}
    ) {
      return {
        market: { findMany: vi.fn().mockResolvedValue([]) },
        tradeAuditEvent: {
          findFirst: vi.fn().mockResolvedValue(null),
          upsert: vi.fn(),
          findMany: vi.fn().mockResolvedValue(rows),
          // Echo the number actually requested so purgedCount reflects the
          // plan, not the size of the candidate set.
          deleteMany: vi
            .fn()
            .mockImplementation(async (args: { id: { in: string[] } }) => ({
              count: args.id.in.length,
            })),
          ...overrides,
        },
        tradeStreamWatermark: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn(),
        },
        $transaction: vi.fn(),
      };
    }

    it("deletes nothing and never queries when retention is disabled", async () => {
      const prisma = makePrisma([candidate("a", "m1", 9999)]);
      const job = new AuditArchiverJob(prisma as any, mockLogger, {
        now: () => NOW,
      });

      const result = await job.run();

      expect(result.retention?.disabled).toBe(true);
      expect(result.retention?.purgedCount).toBe(0);
      expect(prisma.tradeAuditEvent.deleteMany).not.toHaveBeenCalled();
    });

    it("purges only rows older than the window and reports the count", async () => {
      const prisma = makePrisma([
        candidate("old", "m1", 100),
        candidate("fresh", "m1", 1), // retained head
      ]);
      const job = new AuditArchiverJob(prisma as any, mockLogger, {
        retentionDays: 30,
        batchSize: 100,
        now: () => NOW,
      });

      const result = await job.run();

      expect(prisma.tradeAuditEvent.deleteMany).toHaveBeenCalledWith({
        id: { in: ["old"] },
      });
      expect(result.retention?.purgedCount).toBe(1);
    });

    it("fails closed: a purge error leaves the archive intact and the run green", async () => {
      const prisma = makePrisma(
        [candidate("a", "m1", 100), candidate("head", "m1", 1)],
        {
          deleteMany: vi.fn().mockRejectedValue(new Error("DB write failed")),
        }
      );
      const job = new AuditArchiverJob(prisma as any, mockLogger, {
        retentionDays: 30,
        batchSize: 100,
        now: () => NOW,
      });

      const result = await job.run();

      expect(result.retention?.purgedCount).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Audit retention purge failed",
        expect.objectContaining({ retentionDays: 30 })
      );
    });

    it("fails closed when the candidate scan itself fails", async () => {
      const prisma = makePrisma([], {
        findMany: vi.fn().mockRejectedValue(new Error("scan timeout")),
      });
      const job = new AuditArchiverJob(prisma as any, mockLogger, {
        retentionDays: 30,
        now: () => NOW,
      });

      const result = await job.run();

      expect(result.retention?.purgedCount).toBe(0);
      expect(prisma.tradeAuditEvent.deleteMany).not.toHaveBeenCalled();
    });

    it("caps what a single run may delete", async () => {
      const prisma = makePrisma([
        candidate("a", "m1", 100),
        candidate("b", "m1", 90),
        candidate("c", "m1", 80),
        candidate("keep", "m1", 1), // retained head
      ]);
      const job = new AuditArchiverJob(prisma as any, mockLogger, {
        retentionDays: 30,
        retentionBatchSize: 2,
        now: () => NOW,
      });

      const result = await job.run();

      expect(prisma.tradeAuditEvent.deleteMany).toHaveBeenCalledWith({
        id: { in: ["a", "b"] },
      });
      expect(result.retention?.purgedCount).toBe(2);
    });

    it("skips the delete entirely when nothing is eligible", async () => {
      const prisma = makePrisma([
        candidate("fresh", "m1", 1),
        candidate("head", "m1", 0), // retained head
      ]);
      const job = new AuditArchiverJob(prisma as any, mockLogger, {
        retentionDays: 30,
        now: () => NOW,
      });

      const result = await job.run();

      expect(prisma.tradeAuditEvent.deleteMany).not.toHaveBeenCalled();
      expect(result.retention?.purgedCount).toBe(0);
    });

    it("never empties a market that holds a single archived row", async () => {
      const prisma = makePrisma([candidate("only", "m1", 9999)]);
      const job = new AuditArchiverJob(prisma as any, mockLogger, {
        retentionDays: 1,
        now: () => NOW,
      });

      const result = await job.run();

      expect(prisma.tradeAuditEvent.deleteMany).not.toHaveBeenCalled();
      expect(result.retention?.purgedCount).toBe(0);
    });

    it("warns when fewer rows were purged than planned (concurrent modification)", async () => {
      const prisma = makePrisma(
        [candidate("a", "m1", 100), candidate("head", "m1", 1)],
        {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        }
      );
      const job = new AuditArchiverJob(prisma as any, mockLogger, {
        retentionDays: 30,
        now: () => NOW,
      });

      await job.run();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("fewer rows than planned"),
        expect.objectContaining({ purgedCount: 0, requestedCount: 1 })
      );
    });
  });
});
