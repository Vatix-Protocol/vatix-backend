import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpiryJob } from "./job";
import type { PrismaClient } from "@prisma/client";

describe("ExpiryJob", () => {
  let prisma: PrismaClient;

  beforeEach(() => {
    prisma = {
      market: {
        findMany: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as PrismaClient;
  });

  it("returns zero counts when there are no candidates", async () => {
    vi.mocked(prisma.market.findMany).mockResolvedValue([]);

    const job = new ExpiryJob(prisma);
    const result = await job.run();

    expect(result).toEqual({
      totalCandidates: 0,
      expiredCount: 0,
      skippedCount: 0,
      erroredCount: 0,
    });
  });

  it("reports a non-zero erroredCount when the candidate query fails", async () => {
    vi.mocked(prisma.market.findMany).mockRejectedValue(
      new Error("database unavailable"),
    );

    const job = new ExpiryJob(prisma);
    const result = await job.run();

    expect(result.erroredCount).toBeGreaterThan(0);
    expect(result.totalCandidates).toBe(0);
    expect(result.expiredCount).toBe(0);
    expect(result.skippedCount).toBe(0);
  });
});

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/**
 * Minimal Prisma stub: two ACTIVE candidates with no resting orders. The
 * first market expires normally; the second must be left untouched once the
 * maxRunMs budget is spent.
 */
function makeExpiryPrisma(markets: Array<{ id: string; endTime: Date }>) {
  const marketUpdate = vi.fn().mockResolvedValue({});
  const prisma = {
    market: {
      findMany: vi.fn().mockResolvedValue(markets),
      findUnique: vi.fn().mockImplementation(async ({ where }) => {
        const market = markets.find((m) => m.id === where.id);
        return market ? { ...market, status: "ACTIVE", deletedAt: null } : null;
      }),
      update: marketUpdate,
    },
    order: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    userPosition: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockImplementation(async (fn: any) => fn(prisma)),
  };
  return { prisma, marketUpdate };
}

describe("ExpiryJob maxRunMs", () => {
  it("stops after the first market when maxRunMs is exceeded", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const pastEndTime = new Date(1_000_000 - 60 * 1000);
      const markets = [
        { id: "market-1", endTime: pastEndTime },
        { id: "market-2", endTime: pastEndTime },
      ];
      const { prisma, marketUpdate } = makeExpiryPrisma(markets);

      // Advance the fake clock past the budget while the first market is
      // being expired, so the check trips before the second market.
      prisma.order.findMany.mockImplementation(async () => {
        await vi.advanceTimersByTimeAsync(150);
        return [];
      });

      const job = new ExpiryJob(prisma as any, mockLogger as any, {
        maxRunMs: 100,
      });
      const result = await job.run();

      expect(result.truncated).toBe(true);
      expect(result.unprocessedCount).toBe(1);
      expect(result.expiredCount).toBe(1);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.marketId).toBe("market-1");

      // The second market was never transitioned out of ACTIVE.
      const updatedIds = marketUpdate.mock.calls.map((call) => call[0].where.id);
      expect(updatedIds).toEqual(["market-1"]);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("exceeded maxRunMs"),
        expect.objectContaining({ maxRunMs: 100, remainingCandidates: 1 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ExpiryJob resolved markets", () => {
  it("leaves an already RESOLVED market and its open orders untouched", async () => {
    const pastEndTime = new Date(Date.now() - 60 * 1000);
    const market = { id: "market-resolved", endTime: pastEndTime };

    const marketUpdate = vi.fn().mockResolvedValue({});
    const orderUpdate = vi.fn().mockResolvedValue({});
    const openOrders = [
      { id: "order-1", marketId: market.id, status: "OPEN" },
      { id: "order-2", marketId: market.id, status: "OPEN" },
    ];

    const prisma = {
      market: {
        // The candidate query requires status: ACTIVE, so a RESOLVED market
        // must not be returned as a candidate.
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockImplementation(async ({ where }) =>
          where.id === market.id
            ? { ...market, status: "RESOLVED", deletedAt: null }
            : null,
        ),
        update: marketUpdate,
      },
      order: {
        findMany: vi.fn().mockResolvedValue(openOrders),
        update: orderUpdate,
      },
      userPosition: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn().mockImplementation(async (fn: any) => fn(prisma)),
    };

    const job = new ExpiryJob(prisma as any, mockLogger as any);
    const result = await job.run();

    // The resolved market was never a candidate and was not expired.
    expect(result.totalCandidates).toBe(0);
    expect(result.expiredCount).toBe(0);
    expect(marketUpdate).not.toHaveBeenCalled();

    // Its open orders were left open, not expired or cancelled.
    expect(orderUpdate).not.toHaveBeenCalled();
    expect(openOrders.every((order) => order.status === "OPEN")).toBe(true);

    // The fixture market remains RESOLVED.
    const stored = await prisma.market.findUnique({
      where: { id: market.id },
    });
    expect(stored?.status).toBe("RESOLVED");
  });
});

describe("ExpiryJob concurrent status change", () => {
  it("skips expiry when the transaction observes RESOLVED", async () => {
    const pastEndTime = new Date(Date.now() - 60 * 1000);
    const market = { id: "market-race", endTime: pastEndTime };

    const marketUpdate = vi.fn().mockResolvedValue({});
    const orderUpdate = vi.fn().mockResolvedValue({});

    const prisma = {
      market: {
        // The candidate query still returns the market as ACTIVE, but by the
        // time the transaction re-reads the row it has been RESOLVED by a
        // concurrent writer.
        findMany: vi.fn().mockResolvedValue([market]),
        findUnique: vi.fn().mockImplementation(async ({ where }) =>
          where.id === market.id
            ? { ...market, status: "RESOLVED", deletedAt: null }
            : null,
        ),
        update: marketUpdate,
      },
      order: {
        findMany: vi.fn().mockResolvedValue([]),
        update: orderUpdate,
      },
      userPosition: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn().mockImplementation(async (fn: any) => fn(prisma)),
    };

    const job = new ExpiryJob(prisma as any, mockLogger as any);
    const result = await job.run();

    // The concurrent status change is recorded as skipped, not errored.
    expect(result.skippedCount).toBe(1);
    expect(result.erroredCount).toBe(0);
    expect(result.expiredCount).toBe(0);

    // The market was not transitioned to CANCELLED (or any other status).
    expect(marketUpdate).not.toHaveBeenCalled();
    const cancelledUpdates = marketUpdate.mock.calls.filter(
      (call) => call[0]?.data?.status === "CANCELLED",
    );
    expect(cancelledUpdates).toHaveLength(0);
  });
});
