import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "crypto";
import { AuditArchiverJob } from "./job.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";

const { xrangeMock } = vi.hoisted(() => ({ xrangeMock: vi.fn() }));

vi.mock("../../../../src/services/redis.js", () => ({
  redis: {
    xrange: xrangeMock,
    xlen: vi.fn().mockResolvedValue(0),
    xrevrange: vi.fn().mockResolvedValue([]),
    xinfo: vi.fn().mockResolvedValue([]),
  },
}));

const mockLogger: ILogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/** A Prisma double whose archive and watermark calls can be inspected. */
function makePrisma(
  overrides: {
    marketIds?: string[];
    existingChain?: Array<{ streamId: string; entryHash: string }>;
    upsertEvent?: (args: { where: { streamId: string } }) => Promise<unknown>;
  } = {}
) {
  const archiveCalls: Array<Record<string, any>> = [];
  const watermarkCalls: Array<Record<string, any>> = [];
  const chain = overrides.existingChain ?? [];

  return {
    archiveCalls,
    watermarkCalls,
    prisma: {
      market: {
        findMany: vi
          .fn()
          .mockResolvedValue((overrides.marketIds ?? []).map((id) => ({ id }))),
      },
      tradeAuditEvent: {
        findFirst: vi.fn().mockImplementation(async () => {
          const last = chain[chain.length - 1];
          return last ? { entryHash: last.entryHash } : null;
        }),
        upsert: vi.fn().mockImplementation(async (args: any) => {
          archiveCalls.push(args);
          if (overrides.upsertEvent) return overrides.upsertEvent(args);
          return args;
        }),
      },
      tradeStreamWatermark: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockImplementation(async (args: any) => {
          watermarkCalls.push(args);
          return args;
        }),
      },
      $transaction: vi.fn(),
    } as any,
  };
}

describe("AuditArchiverJob — hash chain integrity (#1107)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xrangeMock.mockResolvedValue([]);
  });

  it("links each archived entry to the previous entry's entryHash", async () => {
    xrangeMock
      .mockResolvedValueOnce([
        ["1-0", ["tradeId", "t-1", "price", "0.5"]],
        ["2-0", ["tradeId", "t-2", "price", "0.6"]],
      ])
      .mockResolvedValueOnce([]);

    const { prisma, archiveCalls } = makePrisma({ marketIds: ["m-1"] });
    const result = await new AuditArchiverJob(prisma, mockLogger, {
      batchSize: 100,
    }).run();

    expect(result.archivedCount).toBe(2);

    const first = archiveCalls[0].create;
    const second = archiveCalls[1].create;

    // Root of the chain is the documented "0" sentinel.
    expect(first.prevHash).toBe("0");

    // The second entry links to the hash actually stored for the first. The
    // previous implementation re-read the chain tail from the DB for every
    // single event, so a concurrent write landing between two events could
    // leave entry 2 linked to a hash that was never persisted.
    expect(second.prevHash).toBe(first.entryHash);
    expect(second.entryHash).toBe(
      createHash("sha256")
        .update(`${second.payload}${first.entryHash}`)
        .digest("hex")
    );
  });

  it("orders the chain tail by streamId, not by archivedAt", async () => {
    const { prisma } = makePrisma({
      marketIds: ["m-1"],
      existingChain: [{ streamId: "5-0", entryHash: "deadbeef" }],
    });

    await new AuditArchiverJob(prisma, mockLogger, {}).run();

    // `archivedAt` is a wall-clock write timestamp: two entries archived in
    // the same millisecond, or an entry re-archived by a replay, can sort
    // differently from the chain itself and produce a false
    // vatix_audit_chain_gap_total alert.
    expect(prisma.tradeAuditEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { streamId: "desc" } })
    );
  });

  it("refuses to archive an entry with no tradeId", async () => {
    xrangeMock
      .mockResolvedValueOnce([["1-0", ["price", "0.5"]]])
      .mockResolvedValue([]);

    const { prisma, archiveCalls } = makePrisma({ marketIds: ["m-1"] });
    const result = await new AuditArchiverJob(prisma, mockLogger, {
      batchSize: 100,
    }).run();

    // An unattributable audit row would poison later chain verification.
    expect(archiveCalls).toHaveLength(0);
    expect(result.erroredCount).toBe(1);
    expect(result.events[0]).toMatchObject({
      status: "error",
      errorMessage: "audit entry has no tradeId field",
    });
  });

  it("stops the market on a failed archive instead of spinning on it", async () => {
    xrangeMock.mockResolvedValue([
      ["1-0", ["tradeId", "t-1"]],
      ["2-0", ["tradeId", "t-2"]],
    ]);

    const { prisma, watermarkCalls } = makePrisma({
      marketIds: ["m-1"],
      upsertEvent: async (args) => {
        if (args.where.streamId === "1-0") {
          throw new Error("deadlock detected");
        }
        return args;
      },
    });

    const result = await new AuditArchiverJob(prisma, mockLogger, {
      batchSize: 100,
    }).run();

    // The old loop continued past the failure without advancing the cursor, so
    // the same poisoned entry was re-read on every iteration — spinning for
    // the lifetime of the process.
    expect(xrangeMock).toHaveBeenCalledTimes(1);
    expect(result.erroredCount).toBe(1);

    // The watermark is never moved past an unarchived entry, so the next run
    // retries it: at-least-once, never a silent skip.
    expect(watermarkCalls).toHaveLength(0);
  });

  it("persists the watermark over entries archived before a failure", async () => {
    // Two batches: the first archives cleanly, the second hits a poisoned entry.
    xrangeMock
      .mockResolvedValueOnce([["1-0", ["tradeId", "t-1"]]])
      .mockResolvedValueOnce([["2-0", ["tradeId", "t-2"]]])
      .mockResolvedValue([]);

    const { prisma, watermarkCalls } = makePrisma({
      marketIds: ["m-1"],
      upsertEvent: async (args) => {
        if (args.where.streamId === "2-0") {
          throw new Error("deadlock detected");
        }
        return args;
      },
    });

    // batchSize 1 forces one entry per xrange call, so the successful entry is
    // committed to the chain before the failing one is reached.
    const result = await new AuditArchiverJob(prisma, mockLogger, {
      batchSize: 1,
    }).run();

    expect(result.archivedCount).toBe(1);
    expect(result.erroredCount).toBe(1);

    // The durable resume point must cover the entry that was actually written,
    // so the next run does not re-read and re-hash it. It must stop short of
    // the failed entry, which stays unarchived and is retried.
    expect(watermarkCalls.at(-1)).toMatchObject({
      update: { marketStreamId: "1-0" },
    });
    expect(
      watermarkCalls.some(
        (c: any) =>
          c.update?.marketStreamId === "2-0" ||
          c.create?.marketStreamId === "2-0"
      )
    ).toBe(false);
  });

  it("moves the watermark only over entries that were durably archived", async () => {
    xrangeMock
      .mockResolvedValueOnce([["1-0", ["tradeId", "t-1"]]])
      .mockResolvedValue([]);

    const { prisma, watermarkCalls } = makePrisma({ marketIds: ["m-1"] });
    await new AuditArchiverJob(prisma, mockLogger, { batchSize: 100 }).run();

    expect(watermarkCalls).toHaveLength(1);
    expect(watermarkCalls[0]).toMatchObject({
      where: { marketId: "m-1" },
      update: { marketStreamId: "1-0" },
    });
  });

  it("advances the cursor past a skipped (empty-field) entry", async () => {
    xrangeMock
      .mockResolvedValueOnce([
        ["1-0", []],
        ["2-0", ["tradeId", "t-2"]],
      ])
      .mockResolvedValue([]);

    const { prisma, archiveCalls, watermarkCalls } = makePrisma({
      marketIds: ["m-1"],
    });
    const result = await new AuditArchiverJob(prisma, mockLogger, {
      batchSize: 100,
    }).run();

    expect(result.skippedCount).toBe(1);
    expect(result.archivedCount).toBe(1);
    // The watermark must cover the skipped entry too, or the job would re-read
    // it on every subsequent run forever.
    expect(watermarkCalls[0]).toMatchObject({
      update: { marketStreamId: "2-0" },
    });
    expect(archiveCalls[0].create).toMatchObject({ tradeId: "t-2" });
  });

  it("enforces maxRunMs inside a market, not only between markets", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      // Every market "succeeds", so only the deadline itself can stop the run.
      xrangeMock.mockImplementation(async () => {
        await vi.advanceTimersByTimeAsync(500);
        return [["1-0", ["tradeId", "t-1"]]];
      });

      const { prisma } = makePrisma({ marketIds: ["m-1", "m-2", "m-3"] });
      await new AuditArchiverJob(prisma, mockLogger, {
        maxRunMs: 100,
        batchSize: 100,
      }).run();

      // A single busy market used to run unbounded, starving every other
      // market, because the deadline was only checked between markets.
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("maxRunMs"),
        expect.any(Object)
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
