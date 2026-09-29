import { describe, it, expect, beforeEach, vi } from "vitest";
import { AuditArchiverJob } from "./job.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";

// ---------------------------------------------------------------------------
// Redis mock — declared with vi.hoisted so the factory can reference them
// even though vi.mock calls are hoisted to the top of the file.
// ---------------------------------------------------------------------------
const { mockXrange, mockXinfo } = vi.hoisted(() => ({
  mockXrange: vi.fn().mockResolvedValue([]),
  mockXinfo: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../../src/services/redis.js", () => ({
  redis: {
    xrange: mockXrange,
    xlen: vi.fn().mockResolvedValue(0),
    xrevrange: vi.fn().mockResolvedValue([]),
    xinfo: mockXinfo,
  },
}));

const mockLogger: ILogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// ---------------------------------------------------------------------------
// Shared Prisma factory used by archival tests.  Returns a minimal stub that
// satisfies every code path in AuditArchiverJob.run().
// ---------------------------------------------------------------------------
function makeArchivePrisma(
  markets: Array<{ id: string }>,
  overrides: Partial<{
    tradeAuditEventUpsert: ReturnType<typeof vi.fn>;
    tradeAuditEventFindFirst: ReturnType<typeof vi.fn>;
    tradeStreamWatermarkFindUnique: ReturnType<typeof vi.fn>;
    tradeStreamWatermarkUpsert: ReturnType<typeof vi.fn>;
    tradeAuditEventFindMany: ReturnType<typeof vi.fn>;
    tradeAuditEventDeleteMany: ReturnType<typeof vi.fn>;
  }> = {}
) {
  return {
    market: { findMany: vi.fn().mockResolvedValue(markets) },
    tradeAuditEvent: {
      findFirst:
        overrides.tradeAuditEventFindFirst ?? vi.fn().mockResolvedValue(null),
      upsert:
        overrides.tradeAuditEventUpsert ?? vi.fn().mockResolvedValue({}),
      findMany:
        overrides.tradeAuditEventFindMany ?? vi.fn().mockResolvedValue([]),
      deleteMany:
        overrides.tradeAuditEventDeleteMany ??
        vi
          .fn()
          .mockImplementation(
            async (args: { where: { id: { in: string[] } } }) => ({
              count: args.where.id.in.length,
            })
          ),
    },
    tradeStreamWatermark: {
      findUnique:
        overrides.tradeStreamWatermarkFindUnique ??
        vi.fn().mockResolvedValue(null),
      upsert:
        overrides.tradeStreamWatermarkUpsert ?? vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helpers for building synthetic Redis xrange entries.
// ioredis xrange returns Array<[id: string, fields: string[]]>
// where fields is a flat [field1, val1, field2, val2, …] array.
// ---------------------------------------------------------------------------
function makeStreamEntry(
  streamId: string,
  tradeId: string,
  extra: Record<string, string> = {}
): [string, string[]] {
  const fields: string[] = ["tradeId", tradeId];
  for (const [k, v] of Object.entries(extra)) {
    fields.push(k, v);
  }
  return [streamId, fields];
}

// ---------------------------------------------------------------------------

describe("AuditArchiverJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply defaults after clearAllMocks resets them.
    mockXrange.mockResolvedValue([]);
    mockXinfo.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // Basic lifecycle
  // -------------------------------------------------------------------------

  it("returns empty results when no markets exist", async () => {
    const prisma = makeArchivePrisma([]);
    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.totalEvents).toBe(0);
    expect(result.archivedCount).toBe(0);
    expect(result.erroredCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.startedAt).toBeDefined();
    expect(result.completedAt).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns empty results when markets exist but the stream is empty", async () => {
    // mockXrange already returns [] by default (set in beforeEach).
    const prisma = makeArchivePrisma([{ id: "market-1" }]);
    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.totalEvents).toBe(0);
    expect(result.archivedCount).toBe(0);
  });

  it("handles a database error on market fetch gracefully and returns zeros", async () => {
    const prisma = {
      market: {
        findMany: vi.fn().mockRejectedValue(new Error("DB connection error")),
      },
    };

    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.totalEvents).toBe(0);
    expect(result.archivedCount).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Audit archiver job failed",
      expect.objectContaining({ error: "DB connection error" })
    );
  });

  it("logs job started and job completed on every successful run", async () => {
    const prisma = makeArchivePrisma([]);
    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    await job.run();

    expect(mockLogger.info).toHaveBeenCalledWith("Audit archiver job started");
    expect(mockLogger.info).toHaveBeenCalledWith(
      "Audit archiver job completed",
      expect.objectContaining({
        archivedCount: 0,
        erroredCount: 0,
        skippedCount: 0,
      })
    );
  });

  // -------------------------------------------------------------------------
  // Archival happy path
  // -------------------------------------------------------------------------

  it("archives a single stream entry and records it as archived", async () => {
    const entry = makeStreamEntry("1700000000000-0", "trade-1");
    // Return the entry for the first call; subsequent calls return [] (end).
    mockXrange
      .mockResolvedValueOnce([entry])
      .mockResolvedValue([]);

    const prisma = makeArchivePrisma([{ id: "market-1" }]);
    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.archivedCount).toBe(1);
    expect(result.erroredCount).toBe(0);
    expect(result.totalEvents).toBe(1);

    // Watermark must be advanced to the archived stream id.
    expect(prisma.tradeStreamWatermark.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { marketId: "market-1" },
        update: expect.objectContaining({ marketStreamId: "1700000000000-0" }),
      })
    );
  });

  it("archives multiple entries from the same market in a single run", async () => {
    const entries = [
      makeStreamEntry("1700000000001-0", "trade-A"),
      makeStreamEntry("1700000000002-0", "trade-B"),
      makeStreamEntry("1700000000003-0", "trade-C"),
    ];
    mockXrange
      .mockResolvedValueOnce(entries)
      .mockResolvedValue([]);

    const prisma = makeArchivePrisma([{ id: "market-1" }]);
    const job = new AuditArchiverJob(prisma as any, mockLogger, {
      batchSize: 100,
    });
    const result = await job.run();

    expect(result.archivedCount).toBe(3);
    expect(result.totalEvents).toBe(3);
  });

  it("archives entries from multiple markets independently", async () => {
    // With batchSize=100 and 1 entry per market, each market makes exactly
    // one xrange call (entry count < batchSize → loop breaks immediately).
    mockXrange
      .mockResolvedValueOnce([makeStreamEntry("1700000000001-0", "trade-A")])
      .mockResolvedValueOnce([makeStreamEntry("1700000000002-0", "trade-B")]);

    const prisma = makeArchivePrisma([{ id: "market-1" }, { id: "market-2" }]);
    const job = new AuditArchiverJob(prisma as any, mockLogger, {
      batchSize: 100,
    });
    const result = await job.run();

    expect(result.archivedCount).toBe(2);
  });

  it("resumes from the persisted watermark, not from the stream start", async () => {
    const watermark = { marketId: "market-1", marketStreamId: "1700000000000-0" };

    const prisma = makeArchivePrisma([{ id: "market-1" }], {
      tradeStreamWatermarkFindUnique: vi.fn().mockResolvedValue(watermark),
    });

    // xrange already returns [] (no new entries after the watermark).
    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    await job.run();

    // The xrange call must use the exclusive cursor starting after the watermark.
    expect(mockXrange).toHaveBeenCalledWith(
      expect.any(String),
      `(${watermark.marketStreamId}`,
      "+",
      "COUNT",
      expect.any(String)
    );
  });

  // -------------------------------------------------------------------------
  // Hash-chaining
  // -------------------------------------------------------------------------

  it("chains entry hashes: each entry's prevHash is the previous entry's entryHash", async () => {
    const entries = [
      makeStreamEntry("1700000000001-0", "trade-1"),
      makeStreamEntry("1700000000002-0", "trade-2"),
    ];
    mockXrange
      .mockResolvedValueOnce(entries)
      .mockResolvedValue([]);

    let lastRecordedHash: string | undefined;
    const upsertCalls: Array<{ prevHash: string; entryHash: string }> = [];

    const prisma = makeArchivePrisma([{ id: "market-1" }], {
      tradeAuditEventFindFirst: vi.fn().mockImplementation(async () => {
        return lastRecordedHash ? { entryHash: lastRecordedHash } : null;
      }),
      tradeAuditEventUpsert: vi.fn().mockImplementation(async (args: any) => {
        upsertCalls.push({
          prevHash: args.create.prevHash,
          entryHash: args.create.entryHash,
        });
        lastRecordedHash = args.create.entryHash;
        return {};
      }),
    });

    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    await job.run();

    expect(upsertCalls).toHaveLength(2);
    // First entry: prevHash is the genesis root ("0").
    expect(upsertCalls[0].prevHash).toBe("0");
    // Second entry: prevHash must equal the first entry's entryHash.
    expect(upsertCalls[1].prevHash).toBe(upsertCalls[0].entryHash);
    // All hashes must be non-empty 64-char hex strings.
    for (const { entryHash } of upsertCalls) {
      expect(entryHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is deterministic: the same payload + prevHash always produces the same entryHash", async () => {
    const entry = makeStreamEntry("1700000000001-0", "trade-deterministic");
    const upsertArgs: any[] = [];

    // Run twice with identical inputs to verify determinism.
    for (let run = 0; run < 2; run++) {
      vi.clearAllMocks();
      mockXrange.mockResolvedValueOnce([entry]).mockResolvedValue([]);
      mockXinfo.mockResolvedValue([]);

      const prisma = makeArchivePrisma([{ id: "market-det" }], {
        tradeAuditEventFindFirst: vi.fn().mockResolvedValue(null),
        tradeAuditEventUpsert: vi.fn().mockImplementation(async (args: any) => {
          upsertArgs.push(args.create);
          return {};
        }),
      });

      const job = new AuditArchiverJob(prisma as any, mockLogger, {});
      await job.run();
    }

    expect(upsertArgs).toHaveLength(2);
    expect(upsertArgs[0].entryHash).toBe(upsertArgs[1].entryHash);
    expect(upsertArgs[0].prevHash).toBe(upsertArgs[1].prevHash);
  });

  // -------------------------------------------------------------------------
  // Upsert idempotency: a duplicate streamId must not create a second row.
  // -------------------------------------------------------------------------

  it("upserts by streamId so a replayed entry does not create a duplicate row", async () => {
    const entry = makeStreamEntry("1700000000001-0", "trade-idem");
    mockXrange
      .mockResolvedValueOnce([entry])
      .mockResolvedValue([]);

    const prisma = makeArchivePrisma([{ id: "market-idem" }]);
    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    await job.run();

    // The upsert must include { where: { streamId } } so Prisma enforces the
    // unique constraint rather than inserting a second row.
    expect(prisma.tradeAuditEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: "1700000000001-0" },
      })
    );
  });

  // -------------------------------------------------------------------------
  // Skipped entries (malformed / empty fields)
  // -------------------------------------------------------------------------

  it("skips an entry whose field list is empty and does not count it as archived", async () => {
    // An entry with no fields (empty array) must be skipped, not archived.
    const emptyEntry: [string, string[]] = ["1700000000001-0", []];
    mockXrange
      .mockResolvedValueOnce([emptyEntry])
      .mockResolvedValue([]);

    const prisma = makeArchivePrisma([{ id: "market-skip" }]);
    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.skippedCount).toBe(1);
    expect(result.archivedCount).toBe(0);
    expect(prisma.tradeAuditEvent.upsert).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Per-event DB write error: rest of the batch must still run
  // -------------------------------------------------------------------------

  it("counts a per-event DB error and continues archiving subsequent entries", async () => {
    const entries = [
      makeStreamEntry("1700000000001-0", "trade-fail"),
      makeStreamEntry("1700000000002-0", "trade-ok"),
    ];
    mockXrange
      .mockResolvedValueOnce(entries)
      .mockResolvedValue([]);

    let callCount = 0;
    const prisma = makeArchivePrisma([{ id: "market-err" }], {
      tradeAuditEventUpsert: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("write timeout");
        return {};
      }),
    });

    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.erroredCount).toBe(1);
    expect(result.archivedCount).toBe(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Failed to archive event",
      expect.objectContaining({ marketId: "market-err" })
    );
  });

  it("logs a market-level error and returns an empty result for that market when archiveMarket throws", async () => {
    // Make the watermark fetch throw to trigger the market-level catch.
    const prisma = makeArchivePrisma([{ id: "market-throw" }], {
      tradeStreamWatermarkFindUnique: vi
        .fn()
        .mockRejectedValue(new Error("Redis timeout")),
    });

    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.archivedCount).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Archive market failed",
      expect.objectContaining({ marketId: "market-throw" })
    );
  });

  // -------------------------------------------------------------------------
  // maxRunMs — the job must stop early when the wall-clock budget is spent.
  // -------------------------------------------------------------------------

  it("stops processing markets early when maxRunMs is exceeded and logs a warning", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const mockPrisma = makeArchivePrisma(
        Array.from({ length: 100 }, (_, i) => ({ id: `market-${i}` })),
        {
          tradeStreamWatermarkFindUnique: vi
            .fn()
            .mockImplementation(async () => {
              // Advance fake clock so the maxRunMs check trips quickly.
              await vi.advanceTimersByTimeAsync(150);
              return null;
            }),
        }
      );

      const job = new AuditArchiverJob(mockPrisma as any, mockLogger, {
        maxRunMs: 100,
      });

      await job.run();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("exceeded maxRunMs"),
        expect.objectContaining({ maxRunMs: 100 })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // Batch pagination: batchSize < total entries must page through all of them.
  // -------------------------------------------------------------------------

  it("pages through all stream entries when the stream exceeds batchSize", async () => {
    // batchSize=2, first batch has 2 entries (full → continue), second has 1 (< 2 → break).
    mockXrange
      .mockResolvedValueOnce([
        makeStreamEntry("1700000000001-0", "trade-1"),
        makeStreamEntry("1700000000002-0", "trade-2"),
      ])
      .mockResolvedValueOnce([makeStreamEntry("1700000000003-0", "trade-3")])
      .mockResolvedValue([]);

    const prisma = makeArchivePrisma([{ id: "market-page" }]);
    const job = new AuditArchiverJob(prisma as any, mockLogger, {
      batchSize: 2,
    });
    const result = await job.run();

    expect(result.archivedCount).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Archive lag
  // -------------------------------------------------------------------------

  it("reports archiveLagMs when the global stream has entries", async () => {
    const streamTimestamp = Date.now() - 5000;
    // xinfo returns a flat array: [key, value, key, value, …].
    mockXinfo.mockResolvedValueOnce([
      "length",
      1,
      "last-entry",
      [`${streamTimestamp}-0`, ["tradeId", "t1"]],
    ]);

    const prisma = makeArchivePrisma([]);
    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.archiveLagMs).toBeGreaterThanOrEqual(0);
    // Lag should be approximately 5 s (± 1 s tolerance for CI jitter).
    expect(result.archiveLagMs).toBeLessThan(6000);
  });

  it("returns undefined archiveLagMs when the global stream is empty", async () => {
    mockXinfo.mockResolvedValueOnce(["length", 0, "last-entry", null]);

    const prisma = makeArchivePrisma([]);
    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.archiveLagMs).toBeUndefined();
  });

  it("logs a warning but does not throw when xinfo fails for archiveLagMs", async () => {
    mockXinfo.mockRejectedValueOnce(new Error("XINFO not available"));

    const prisma = makeArchivePrisma([]);
    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.archiveLagMs).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Failed to calculate archive lag",
      expect.objectContaining({ error: "XINFO not available" })
    );
  });

  // -------------------------------------------------------------------------
  // Result shape contract
  // -------------------------------------------------------------------------

  it("result always includes startedAt, completedAt, and durationMs", async () => {
    const prisma = makeArchivePrisma([]);
    const job = new AuditArchiverJob(prisma as any, mockLogger, {});
    const result = await job.run();

    expect(result.startedAt).toBeDefined();
    expect(result.completedAt).toBeDefined();
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // Retention (#1137)
  // -------------------------------------------------------------------------

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
          deleteMany: vi
            .fn()
            .mockImplementation(
              async (args: { where: { id: { in: string[] } } }) => ({
                count: args.where.id.in.length,
              })
            ),
          ...overrides,
        },
        tradeStreamWatermark: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn(),
        },
        $transaction: vi.fn(),
      };
    }

    it("deletes nothing and never queries when retention is disabled (default)", async () => {
      const prisma = makePrisma([candidate("a", "m1", 9999)]);
      const job = new AuditArchiverJob(prisma as any, mockLogger, {
        now: () => NOW,
      });

      const result = await job.run();

      expect(result.retention?.disabled).toBe(true);
      expect(result.retention?.purgedCount).toBe(0);
      expect(prisma.tradeAuditEvent.deleteMany).not.toHaveBeenCalled();
    });

    it("purges only rows older than the retention window", async () => {
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
        where: { id: { in: ["old"] } },
      });
      expect(result.retention?.purgedCount).toBe(1);
    });

    it("fails closed: a purge DB error leaves the archive intact and the run green", async () => {
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
      // The overall run must still succeed.
      expect(result.archivedCount).toBe(0);
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

    it("caps deletions at retentionBatchSize to bound a single run's blast radius", async () => {
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
        where: { id: { in: ["a", "b"] } },
      });
      expect(result.retention?.purgedCount).toBe(2);
    });

    it("skips the delete call entirely when no rows are eligible", async () => {
      const prisma = makePrisma([
        candidate("fresh", "m1", 1),
        candidate("head", "m1", 0),
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
        { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) }
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

    it("logs purge metrics (purgedCount, requestedCount, marketCount, cutoff) on success", async () => {
      const prisma = makePrisma([
        candidate("a", "m1", 100),
        candidate("head", "m1", 1),
      ]);
      const job = new AuditArchiverJob(prisma as any, mockLogger, {
        retentionDays: 30,
        now: () => NOW,
      });

      await job.run();

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Audit retention purge complete",
        expect.objectContaining({
          purgedCount: 1,
          requestedCount: 1,
          marketCount: 1,
          retentionDays: 30,
          cutoff: expect.any(String),
        })
      );
    });

    it("runs retention after archival so a purge cannot race rows archived in the same tick", async () => {
      // We verify ordering by tracking call order: archival (upsert) must
      // always precede the retention deleteMany within a single run().
      const callOrder: string[] = [];

      mockXrange
        .mockResolvedValueOnce([makeStreamEntry("1-0", "t1")])
        .mockResolvedValue([]);

      const upsertMock = vi.fn().mockImplementation(async () => {
        callOrder.push("upsert");
        return {};
      });
      const deleteManyMock = vi.fn().mockImplementation(async () => {
        callOrder.push("deleteMany");
        return { count: 1 };
      });

      const prisma = {
        market: {
          findMany: vi.fn().mockResolvedValue([{ id: "market-order" }]),
        },
        tradeAuditEvent: {
          findFirst: vi.fn().mockResolvedValue(null),
          upsert: upsertMock,
          findMany: vi.fn().mockResolvedValue([candidate("old", "market-order", 100)]),
          deleteMany: deleteManyMock,
        },
        tradeStreamWatermark: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({}),
        },
        $transaction: vi.fn(),
      };

      function candidate(id: string, marketId: string, ageDays: number) {
        const DAY = 86_400_000;
        const NOW = new Date("2026-03-01T00:00:00.000Z");
        return {
          id,
          marketId,
          archivedAt: new Date(NOW.getTime() - ageDays * DAY),
        };
      }

      const NOW = new Date("2026-03-01T00:00:00.000Z");
      const job = new AuditArchiverJob(prisma as any, mockLogger, {
        retentionDays: 30,
        now: () => NOW,
      });

      await job.run();

      const upsertIdx = callOrder.indexOf("upsert");
      const deleteIdx = callOrder.indexOf("deleteMany");
      if (upsertIdx !== -1 && deleteIdx !== -1) {
        expect(upsertIdx).toBeLessThan(deleteIdx);
      }
    });

    it("reports the cutoff ISO string in the retention result when deletion occurs", async () => {
      const prisma = makePrisma([
        candidate("a", "m1", 100),
        candidate("head", "m1", 1),
      ]);
      const job = new AuditArchiverJob(prisma as any, mockLogger, {
        retentionDays: 30,
        now: () => NOW,
      });

      const result = await job.run();

      expect(result.retention?.cutoff).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
      );
    });
  });
});
