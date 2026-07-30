import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FinalizationJob, FinalizationValidationError } from "./job.js";
import type { FinalizationJobConfig, FinalizationCandidate } from "./job.js";
import type {
  FinalizationJobResult,
  FinalizationCandidateResult,
} from "./types.js";
import type { Logger } from "../../../indexer/src/logger.js";
import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    }),
  };
}

function makeConfig(challengeWindowSeconds: number): FinalizationJobConfig {
  return { challengeWindowSeconds };
}

function makeCandidate(
  overrides?: Partial<FinalizationCandidate>
): FinalizationCandidate {
  return {
    id: "candidate-1",
    marketId: "market-1",
    proposedOutcome: true,
    source: "chainlink",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Builds a mock tx object for $transaction. marketUpdateCount controls how
 * many rows tx.market.updateMany() reports as matched — 0 simulates a market
 * that was canceled/soft-deleted concurrently (see MarketNotEligibleError).
 * lockedStatus controls what the row-lock query (`SELECT ... FOR UPDATE`)
 * reports as the candidate's current status — "PROPOSED" simulates the
 * uncontended case; anything else simulates a concurrent challenge/finalize
 * winning the race first (see CandidateNotEligibleError).
 */
function makeTx(
  marketUpdateCount = 1,
  lockedStatus: string | null = "PROPOSED"
) {
  const create = vi.fn().mockResolvedValue({ id: "resolution-1" });
  const marketUpdateMany = vi
    .fn()
    .mockResolvedValue({ count: marketUpdateCount });
  const updateCandidate = vi.fn().mockResolvedValue({});
  const positionUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
  const auditLogCreate = vi.fn().mockResolvedValue({});
  const queryRaw = vi
    .fn()
    .mockResolvedValue(
      lockedStatus === null ? [] : [{ id: "locked-row", status: lockedStatus }]
    );

  const tx = {
    resolution: { create },
    market: { updateMany: marketUpdateMany },
    resolutionCandidate: { update: updateCandidate },
    userPosition: { updateMany: positionUpdateMany },
    resolutionAuditLog: { create: auditLogCreate },
    $queryRaw: queryRaw,
  };

  return {
    tx,
    create,
    marketUpdateMany,
    updateCandidate,
    positionUpdateMany,
    auditLogCreate,
    queryRaw,
  };
}

function makePrisma(
  candidates: FinalizationCandidate[] = [],
  resolutionError: boolean = false
) {
  const { tx } = makeTx();

  const transaction = vi
    .fn()
    .mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        return await fn(tx);
      }
    );

  if (resolutionError) {
    transaction.mockRejectedValue(new Error("DB write failed"));
  }

  return {
    resolutionCandidate: {
      findMany: vi.fn().mockResolvedValue(candidates),
    },
    $transaction: transaction,
  } as unknown as PrismaClient;
}

describe("FinalizationJob", () => {
  describe("input validation", () => {
    it("throws FinalizationValidationError (statusCode 400) for negative challengeWindowSeconds", async () => {
      const job = new FinalizationJob(
        makePrisma(),
        makeLogger(),
        makeConfig(-1)
      );
      await expect(job.run()).rejects.toThrow(FinalizationValidationError);
      await expect(job.run()).rejects.toMatchObject({ statusCode: 400 });
    });

    it("throws FinalizationValidationError for NaN challengeWindowSeconds", async () => {
      const job = new FinalizationJob(
        makePrisma(),
        makeLogger(),
        makeConfig(NaN)
      );
      await expect(job.run()).rejects.toThrow(FinalizationValidationError);
    });

    it("throws FinalizationValidationError for Infinity challengeWindowSeconds", async () => {
      const job = new FinalizationJob(
        makePrisma(),
        makeLogger(),
        makeConfig(Infinity)
      );
      await expect(job.run()).rejects.toThrow(FinalizationValidationError);
    });

    it("throws FinalizationValidationError for -Infinity challengeWindowSeconds", async () => {
      const job = new FinalizationJob(
        makePrisma(),
        makeLogger(),
        makeConfig(-Infinity)
      );
      await expect(job.run()).rejects.toThrow(FinalizationValidationError);
    });

    it("accepts zero challengeWindowSeconds", async () => {
      const job = new FinalizationJob(
        makePrisma(),
        makeLogger(),
        makeConfig(0)
      );
      const result = await job.run();
      expect(result.totalCandidates).toBe(0);
    });

    it("accepts a positive challengeWindowSeconds", async () => {
      const job = new FinalizationJob(
        makePrisma(),
        makeLogger(),
        makeConfig(3600)
      );
      const result = await job.run();
      expect(result.totalCandidates).toBe(0);
    });

    it("accepts a fractional challengeWindowSeconds", async () => {
      const job = new FinalizationJob(
        makePrisma(),
        makeLogger(),
        makeConfig(0.5)
      );
      const result = await job.run();
      expect(result.totalCandidates).toBe(0);
    });
  });

  describe("candidate finalization", () => {
    it("creates Resolution records for eligible PROPOSED candidates", async () => {
      const candidates = [makeCandidate()];
      const prisma = makePrisma(candidates);
      const logger = makeLogger();
      const job = new FinalizationJob(prisma, logger, makeConfig(3600));

      const result = await job.run();

      expect(result.totalCandidates).toBe(1);
      expect(result.finalizedCount).toBe(1);
      expect(result.erroredCount).toBe(0);
      expect(result.candidates[0].status).toBe("finalized");
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it("creates Resolution with correct outcome and provenance", async () => {
      const candidates = [
        makeCandidate({
          id: "cand-yes",
          marketId: "mkt-1",
          proposedOutcome: true,
          source: "chainlink",
        }),
      ];
      const { tx, create } = makeTx();
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(tx)
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const job = new FinalizationJob(prisma, makeLogger(), makeConfig(3600));
      await job.run();

      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          marketId: "mkt-1",
          outcome: true,
          provenance: "chainlink",
        }),
      });
    });

    it("updates Market status to RESOLVED and sets outcome, guarded against canceled/deleted markets", async () => {
      const candidates = [
        makeCandidate({ marketId: "mkt-1", proposedOutcome: false }),
      ];
      const { tx, marketUpdateMany } = makeTx();
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(tx)
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const job = new FinalizationJob(prisma, makeLogger(), makeConfig(3600));
      await job.run();

      expect(marketUpdateMany).toHaveBeenCalledWith({
        where: {
          id: "mkt-1",
          status: { in: ["ACTIVE"] },
          deletedAt: null,
        },
        data: expect.objectContaining({
          status: "RESOLVED",
          outcome: false,
        }),
      });
    });

    it("updates resolution candidate status to ACCEPTED", async () => {
      const candidates = [makeCandidate({ id: "cand-1" })];
      const { tx, updateCandidate } = makeTx();
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(tx)
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const job = new FinalizationJob(prisma, makeLogger(), makeConfig(3600));
      await job.run();

      expect(updateCandidate).toHaveBeenCalledWith({
        where: { id: "cand-1" },
        data: { status: "ACCEPTED" },
      });
    });

    it("settles UserPosition records for the market", async () => {
      const candidates = [makeCandidate({ marketId: "mkt-1" })];
      const { tx, positionUpdateMany } = makeTx();
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(tx)
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const job = new FinalizationJob(prisma, makeLogger(), makeConfig(3600));
      await job.run();

      expect(positionUpdateMany).toHaveBeenCalledWith({
        where: { marketId: "mkt-1" },
        data: { isSettled: true },
      });
    });

    it("handles multiple candidates in a single run", async () => {
      const candidates = [
        makeCandidate({ id: "cand-1", marketId: "mkt-1" }),
        makeCandidate({ id: "cand-2", marketId: "mkt-2" }),
      ];
      const prisma = makePrisma(candidates);
      const job = new FinalizationJob(prisma, makeLogger(), makeConfig(3600));

      const result = await job.run();

      expect(result.totalCandidates).toBe(2);
      expect(result.finalizedCount).toBe(2);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it("returns FinalizationJobResult with correct shape", async () => {
      const candidates = [makeCandidate()];
      const prisma = makePrisma(candidates);
      const job = new FinalizationJob(prisma, makeLogger(), makeConfig(3600));

      const result = await job.run();

      expect(result).toHaveProperty("totalCandidates");
      expect(result).toHaveProperty("finalizedCount");
      expect(result).toHaveProperty("skippedCount");
      expect(result).toHaveProperty("erroredCount");
      expect(result).toHaveProperty("candidates");
      expect(result).toHaveProperty("startedAt");
      expect(result).toHaveProperty("completedAt");
      expect(result).toHaveProperty("durationMs");
      expect(Array.isArray(result.candidates)).toBe(true);
    });

    it("sets resolutionTime on the market", async () => {
      const candidates = [makeCandidate()];
      const { tx, marketUpdateMany } = makeTx();
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(tx)
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const job = new FinalizationJob(prisma, makeLogger(), makeConfig(3600));
      await job.run();

      expect(marketUpdateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: candidates[0].marketId }),
        data: expect.objectContaining({
          resolutionTime: expect.any(Date),
        }),
      });
    });
  });

  describe("canceled/soft-deleted market handling", () => {
    it("excludes CANCELLED and soft-deleted markets from the candidate query", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const prisma = {
        resolutionCandidate: { findMany },
        $transaction: vi.fn(),
      } as unknown as PrismaClient;

      const job = new FinalizationJob(prisma, makeLogger(), makeConfig(3600));
      await job.run();

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            market: {
              status: { in: ["ACTIVE"] },
              deletedAt: null,
            },
          }),
        })
      );
    });

    it("skips (not errors) a candidate whose market was canceled/deleted concurrently", async () => {
      const candidates = [
        makeCandidate({ id: "cand-race", marketId: "mkt-race" }),
      ];
      // updateMany reports 0 rows matched — the market's status/deletedAt
      // changed between the candidate query and the transaction.
      const { tx, updateCandidate, positionUpdateMany } = makeTx(0);
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(tx)
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const logger = makeLogger();
      const job = new FinalizationJob(prisma, logger, makeConfig(3600));

      const result = await job.run();

      expect(result.finalizedCount).toBe(0);
      expect(result.erroredCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(result.candidates[0]).toMatchObject({
        candidateId: "cand-race",
        marketId: "mkt-race",
        status: "skipped",
      });
      // Rolled back before touching the candidate or positions.
      expect(updateCandidate).not.toHaveBeenCalled();
      expect(positionUpdateMany).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        "Finalization candidate skipped: market canceled or deleted",
        expect.objectContaining({
          candidateId: "cand-race",
          marketId: "mkt-race",
        })
      );
    });

    it("does not log a skipped candidate as an error", async () => {
      const candidates = [makeCandidate({ id: "cand-race" })];
      const { tx } = makeTx(0);
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(tx)
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const logger = makeLogger();
      const job = new FinalizationJob(prisma, logger, makeConfig(3600));
      await job.run();

      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("captures error per candidate and continues processing others", async () => {
      const candidates = [
        makeCandidate({ id: "cand-1", marketId: "mkt-1" }),
        makeCandidate({ id: "cand-2", marketId: "mkt-2" }),
      ];
      const { tx: okTx } = makeTx();
      const transaction = vi
        .fn()
        .mockImplementationOnce(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(okTx)
        )
        .mockRejectedValueOnce(new Error("DB write failed"));

      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const logger = makeLogger();
      const job = new FinalizationJob(prisma, logger, makeConfig(3600));

      const result = await job.run();

      expect(result.totalCandidates).toBe(2);
      expect(result.finalizedCount).toBe(1);
      expect(result.erroredCount).toBe(1);
      expect(result.candidates[0].status).toBe("finalized");
      expect(result.candidates[1].status).toBe("errored");
      expect(result.candidates[1].error).toBe("DB write failed");
    });

    it("logs error when candidate finalization fails", async () => {
      const candidates = [makeCandidate({ id: "cand-err" })];
      const prisma = makePrisma(candidates, true);
      const logger = makeLogger();
      const job = new FinalizationJob(prisma, logger, makeConfig(3600));

      await job.run();

      expect(logger.error).toHaveBeenCalledWith(
        "Finalization candidate failed",
        expect.objectContaining({
          candidateId: "cand-err",
          error: "DB write failed",
        })
      );
    });

    it("returns empty result with zero counts when query fails", async () => {
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockRejectedValue(new Error("Query failed")),
        },
        $transaction: vi.fn(),
      } as unknown as PrismaClient;

      const logger = makeLogger();
      const job = new FinalizationJob(prisma, logger, makeConfig(3600));

      const result = await job.run();

      expect(result.totalCandidates).toBe(0);
      expect(result.finalizedCount).toBe(0);
      expect(result.erroredCount).toBe(0);
      expect(result.candidates).toHaveLength(0);
      expect(logger.error).toHaveBeenCalledWith(
        "Finalization job failed to query candidates",
        expect.objectContaining({ error: "Query failed" })
      );
    });
  });

  describe("challenge window gating", () => {
    it("skips a candidate that is still within the challenge window", async () => {
      const recentCandidate = makeCandidate({
        id: "recent",
        createdAt: new Date(Date.now() - 1000), // created 1 second ago
      });
      const prisma = makePrisma([recentCandidate]);

      // Challenge window of 1 hour → recent candidate is still within it
      const job = new FinalizationJob(prisma, makeLogger(), {
        challengeWindowSeconds: 3600,
      });
      const result = await job.run();

      expect(result.totalCandidates).toBe(1);
      expect(result.finalizedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(result.candidates[0].status).toBe("skipped");
    });

    it("finalizes a candidate that is past the challenge window", async () => {
      const oldCandidate = makeCandidate({
        id: "old",
        createdAt: new Date(Date.now() - 7200_000), // created 2 hours ago
      });
      const prisma = makePrisma([oldCandidate]);

      const job = new FinalizationJob(prisma, makeLogger(), {
        challengeWindowSeconds: 3600, // 1 hour window
      });
      const result = await job.run();

      expect(result.totalCandidates).toBe(1);
      expect(result.finalizedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
    });

    it("uses isChallengeWindowOpen utility for the per-candidate check", async () => {
      // A candidate that is exactly at the edge of the window boundary:
      // createdAt exactly challengeWindowSeconds ago → window JUST closed
      const edgeCandidate = makeCandidate({
        id: "edge",
        createdAt: new Date(Date.now() - 3600_000), // created exactly 1 hour ago
      });
      const prisma = makePrisma([edgeCandidate]);

      const job = new FinalizationJob(prisma, makeLogger(), {
        challengeWindowSeconds: 3600, // 1 hour window
      });

      // At the exact boundary (now >= opensAt && now < closesAt):
      // closesAt = proposedAt + 3600s = now. Since the upper bound is
      // exclusive (now < closesAt), the window is now closed → finalize.
      const result = await job.run();
      expect(result.finalizedCount).toBe(1);
    });
  });

  describe("challenge window boundaries (deterministic clock)", () => {
    const NOW = new Date("2026-01-01T12:00:00.000Z");
    const WINDOW_SECONDS = 3600; // 1 hour

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("passes a windowCutoff of now - challengeWindowSeconds to the candidate query", async () => {
      const prisma = makePrisma([]);
      const job = new FinalizationJob(prisma, makeLogger(), {
        challengeWindowSeconds: WINDOW_SECONDS,
      });

      await job.run();

      expect(prisma.resolutionCandidate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { lte: new Date("2026-01-01T11:00:00.000Z") },
          }),
        })
      );
    });

    it("skips a candidate created 1ms after the cutoff (still inside the window)", async () => {
      const candidate = makeCandidate({
        id: "just-inside",
        createdAt: new Date("2026-01-01T11:00:00.001Z"), // closes 1ms after NOW
      });
      const prisma = makePrisma([candidate]);
      const job = new FinalizationJob(prisma, makeLogger(), {
        challengeWindowSeconds: WINDOW_SECONDS,
      });

      const result = await job.run();

      expect(result.candidates[0].status).toBe("skipped");
    });

    it("finalizes a candidate whose window closes at exactly now (exclusive upper bound)", async () => {
      const candidate = makeCandidate({
        id: "exact-close",
        createdAt: new Date("2026-01-01T11:00:00.000Z"), // closes exactly at NOW
      });
      const prisma = makePrisma([candidate]);
      const job = new FinalizationJob(prisma, makeLogger(), {
        challengeWindowSeconds: WINDOW_SECONDS,
      });

      const result = await job.run();

      expect(result.candidates[0].status).toBe("finalized");
    });

    it("finalizes a candidate created 1ms before the cutoff (just past the window)", async () => {
      const candidate = makeCandidate({
        id: "just-outside",
        createdAt: new Date("2026-01-01T10:59:59.999Z"), // closes 1ms before NOW
      });
      const prisma = makePrisma([candidate]);
      const job = new FinalizationJob(prisma, makeLogger(), {
        challengeWindowSeconds: WINDOW_SECONDS,
      });

      const result = await job.run();

      expect(result.candidates[0].status).toBe("finalized");
    });

    it("skips a candidate proposed at exactly now (window just opened)", async () => {
      const candidate = makeCandidate({
        id: "just-opened",
        createdAt: new Date(NOW),
      });
      const prisma = makePrisma([candidate]);
      const job = new FinalizationJob(prisma, makeLogger(), {
        challengeWindowSeconds: WINDOW_SECONDS,
      });

      const result = await job.run();

      expect(result.candidates[0].status).toBe("skipped");
    });

    it("finalizes immediately when challengeWindowSeconds is 0", async () => {
      const candidate = makeCandidate({
        id: "zero-window",
        createdAt: new Date(NOW),
      });
      const prisma = makePrisma([candidate]);
      const job = new FinalizationJob(prisma, makeLogger(), {
        challengeWindowSeconds: 0,
      });

      const result = await job.run();

      expect(result.candidates[0].status).toBe("finalized");
    });
  });

  describe("CHALLENGED and REJECTED paths", () => {
    it("only queries PROPOSED candidates and ignores CHALLENGED/REJECTED", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const prisma = {
        resolutionCandidate: { findMany },
        $transaction: vi.fn(),
      } as unknown as PrismaClient;

      const job = new FinalizationJob(prisma, makeLogger(), makeConfig(3600));
      await job.run();

      expect(findMany).toHaveBeenCalledWith({
        where: {
          status: "PROPOSED",
          createdAt: { lte: expect.any(Date) },
          market: {
            status: { in: ["ACTIVE"] },
            deletedAt: null,
          },
        },
        select: {
          id: true,
          marketId: true,
          proposedOutcome: true,
          source: true,
          createdAt: true,
        },
      });
    });
  });

  describe("row-locking mutual exclusion with concurrent challenge", () => {
    it("locks the candidate row with SELECT ... FOR UPDATE before writing", async () => {
      const candidates = [makeCandidate({ id: "cand-1" })];
      const { tx, queryRaw } = makeTx();
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(tx)
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const job = new FinalizationJob(prisma, makeLogger(), makeConfig(3600));
      await job.run();

      expect(queryRaw).toHaveBeenCalledTimes(1);
    });

    it("skips (not errors) a candidate whose lock reveals it was CHALLENGED concurrently", async () => {
      const candidates = [
        makeCandidate({ id: "cand-race", marketId: "mkt-race" }),
      ];
      // The row lock reports CHALLENGED — a challenge write committed
      // between the outer findMany and this transaction acquiring the lock.
      const { tx, create, updateCandidate } = makeTx(1, "CHALLENGED");
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(tx)
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const logger = makeLogger();
      const job = new FinalizationJob(prisma, logger, makeConfig(3600));

      const result = await job.run();

      expect(result.finalizedCount).toBe(0);
      expect(result.erroredCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(result.candidates[0]).toMatchObject({
        candidateId: "cand-race",
        marketId: "mkt-race",
        status: "skipped",
      });
      // Never created a Resolution or flipped status for a challenged candidate.
      expect(create).not.toHaveBeenCalled();
      expect(updateCandidate).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        "Finalization candidate skipped: lost race to a concurrent challenge/status change",
        expect.objectContaining({
          candidateId: "cand-race",
          marketId: "mkt-race",
        })
      );
    });

    it("skips when the locked row is missing entirely", async () => {
      const candidates = [makeCandidate({ id: "cand-gone" })];
      const { tx, create } = makeTx(1, null);
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(tx)
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const result = await new FinalizationJob(
        prisma,
        makeLogger(),
        makeConfig(3600)
      ).run();

      expect(result.skippedCount).toBe(1);
      expect(create).not.toHaveBeenCalled();
    });

    it("writes a ResolutionAuditLog entry on the finalize win path", async () => {
      const candidates = [makeCandidate({ id: "cand-1", marketId: "mkt-1" })];
      const { tx, auditLogCreate } = makeTx();
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(tx)
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      await new FinalizationJob(prisma, makeLogger(), makeConfig(3600)).run();

      expect(auditLogCreate).toHaveBeenCalledWith({
        data: {
          candidateId: "cand-1",
          marketId: "mkt-1",
          action: "FINALIZE",
          beforeStatus: "PROPOSED",
          afterStatus: "ACCEPTED",
          actor: "finalization-worker",
        },
      });
    });
  });

  describe("maxRunMs elapsed-time guard", () => {
    it("processes all candidates when maxRunMs is 0 (disabled)", async () => {
      const candidates = [
        makeCandidate({ id: "c1", marketId: "m1" }),
        makeCandidate({ id: "c2", marketId: "m2" }),
      ];
      const prisma = makePrisma(candidates);
      const job = new FinalizationJob(prisma, makeLogger(), {
        challengeWindowSeconds: 3600,
        maxRunMs: 0,
      });

      const result = await job.run();

      expect(result.totalCandidates).toBe(2);
      expect(result.finalizedCount).toBe(2);
    });

    it("stops early when elapsed time exceeds maxRunMs", async () => {
      vi.useFakeTimers();
      try {
        const candidates = [
          makeCandidate({ id: "c1", marketId: "m1" }),
          makeCandidate({ id: "c2", marketId: "m2" }),
          makeCandidate({ id: "c3", marketId: "m3" }),
        ];

        // Each $transaction call advances fake time by 200 ms
        const { tx } = makeTx();
        const transaction = vi
          .fn()
          .mockImplementation(
            async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
              await vi.advanceTimersByTimeAsync(200);
              return fn(tx);
            }
          );
        const prisma = {
          resolutionCandidate: {
            findMany: vi.fn().mockResolvedValue(candidates),
          },
          $transaction: transaction,
        } as unknown as PrismaClient;

        const logger = makeLogger();
        // Allow only 300 ms → first candidate (200 ms) fits, second is blocked
        const job = new FinalizationJob(prisma, logger, {
          challengeWindowSeconds: 3600,
          maxRunMs: 300,
        });

        const result = await job.run();

        // Only the first candidate was processed before the guard triggered
        expect(result.finalizedCount).toBe(1);
        expect(result.totalCandidates).toBe(3);
        expect(logger.warn).toHaveBeenCalledWith(
          "Finalization job exceeded maxRunMs, stopping early",
          expect.objectContaining({ maxRunMs: 300 })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not stop early when all candidates finish within maxRunMs", async () => {
      const candidates = [
        makeCandidate({ id: "c1", marketId: "m1" }),
        makeCandidate({ id: "c2", marketId: "m2" }),
      ];
      const prisma = makePrisma(candidates);
      const logger = makeLogger();
      const job = new FinalizationJob(prisma, logger, {
        challengeWindowSeconds: 3600,
        maxRunMs: 60_000,
      });

      const result = await job.run();

      expect(result.finalizedCount).toBe(2);
      expect(logger.warn).not.toHaveBeenCalledWith(
        "Finalization job exceeded maxRunMs, stopping early",
        expect.anything()
      );
    });
  });
});
