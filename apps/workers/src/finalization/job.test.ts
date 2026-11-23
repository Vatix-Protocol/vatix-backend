import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/client.js";
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
  lockedStatus: string | null = "PROPOSED",
  competingCandidate: { id: string; confidenceScore: number | null } | null = null
) {
  const create = vi.fn().mockResolvedValue({ id: "resolution-1" });
  const marketUpdateMany = vi
    .fn()
    .mockResolvedValue({ count: marketUpdateCount });
  const updateCandidate = vi.fn().mockResolvedValue({});
  const positionUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
  const auditLogCreate = vi.fn().mockResolvedValue({});
  const findFirstCandidate = vi.fn().mockResolvedValue(competingCandidate);
  const queryRaw = vi
    .fn()
    .mockResolvedValue(
      lockedStatus === null ? [] : [{ id: "locked-row", status: lockedStatus }]
    );

  const tx = {
    resolution: { create },
    market: { updateMany: marketUpdateMany },
    resolutionCandidate: {
      update: updateCandidate,
      findFirst: findFirstCandidate,
    },
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
    findFirstCandidate,
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

  describe("CHALLENGED adjudication by confidence score (decimal, never Number(null) -> 0)", () => {
    function makeChallengedTx(
      competing: { id: string; confidenceScore: unknown } | null
    ) {
      const create = vi.fn().mockResolvedValue({ id: "resolution-1" });
      const marketUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const updateCandidate = vi.fn().mockResolvedValue({});
      const positionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const auditLogCreate = vi.fn().mockResolvedValue({});
      const findFirst = vi.fn().mockResolvedValue(competing);
      // Row lock reveals CHALLENGED so the adjudication branch runs.
      const queryRaw = vi
        .fn()
        .mockResolvedValue([{ id: "locked-row", status: "CHALLENGED" }]);

      const tx = {
        resolution: { create },
        market: { updateMany: marketUpdateMany },
        resolutionCandidate: { update: updateCandidate, findFirst },
        userPosition: { updateMany: positionUpdateMany },
        resolutionAuditLog: { create: auditLogCreate },
        $queryRaw: queryRaw,
      };

      return { tx, create, updateCandidate, auditLogCreate, findFirst };
    }

    function runChallenged(
      confidenceScore: number | null,
      competing: { id: string; confidenceScore: unknown } | null
    ) {
      const candidates = [
        makeCandidate({
          id: "cand-challenged",
          marketId: "mkt-challenged",
          status: "CHALLENGED",
          confidenceScore,
        }),
      ];
      const built = makeChallengedTx(competing);

      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(built.tx)
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      return { prisma, ...
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(built.tx)
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      return { prisma, ...built };
    }

    it("upholds the challenge (REJECTS this candidate) when the competing score is strictly higher", async () => {
      const { prisma, create, updateCandidate } = runChallenged(0.4, {
        id: "competitor-1",
        confidenceScore: 0.9,
      });

      const result = await new FinalizationJob(
        prisma,
        makeLogger(),
        makeConfig(3600)
      ).run();

      return { prisma, ...built };
    }

    it("upholds the challenge (REJECTS this candidate) when the competing score is strictly higher", async () => {
      const { prisma, create, updateCandidate } = runChallenged(0.4, {
        id: "competitor-1",
        confidenceScore: 0.9,
      });

      const result = await new FinalizationJob(
        prisma,
        makeLogger(),
        makeConfig(3600)
      ).run();

      expect(updateCandidate).toHaveBeenCalledWith({
        where: { id: "cand-challenged" },
        data: { status: "REJECTED" },
      });
      expect(create).not.toHaveBeenCalled();
      expect(result.candidates[0]).toMatchObject({
        candidateId: "cand-challenged",
        status: "finalized",
      });
    });

    it("denies the challenge and finalizes when this candidate's own score is strictly higher", async () => {
      const { prisma, create, updateCandidate } = runChallenged(0.9, {
        id: "competitor-1",
        confidenceScore: 0.4,
      });

      const result = await new FinalizationJob(
        prisma,
        makeLogger(),
        makeConfig(3600)
      ).run();

      expect(create).toHaveBeenCalledTimes(1);
      expect(findFirstCandidate).toHaveBeenCalledTimes(1);
      expect(result.erroredCount).toBe(0);
      expect(result.candidates[0].status).toBe("finalized");
      // The challenge was denied (no better competitor), so this committed
      // as a real finalize: a Resolution was created and the candidate
      // flipped to ACCEPTED, not merely "didn't throw".
      expect(updateCandidate).toHaveBeenCalledWith({
        where: { id: "cand-challenged" },
        data: { status: "ACCEPTED" },
      });
      expect(auditLogCreate).toHaveBeenCalledWith({
        data: {
          candidateId: "cand-challenged",
          marketId: "mkt-1",
          action: "FINALIZE",
          beforeStatus: "CHALLENGED",
          afterStatus: "ACCEPTED",
          actor: "finalization-worker",
        },
      });
    });

    it("rejects (never finalize
      expect(updateCandidate).toHaveBeenCalledWith({
        where: { id: "cand-challenged" },
        data: { status: "ACCEPTED" },
      });
      expect(result.candidates[0]).toMatchObject({
        candidateId: "cand-challenged",
        status: "finalized",
      });
    });

    it("does not finalize or reject on a tie — equal decimal scores are not a denial", async () => {
      const { prisma, create, updateCandidate } = runChallenged(0.5, {
        id: "competitor-1",
        confidenceScore: 0.5,
      });

      const result = await new FinalizationJob(
        prisma,
        makeLogger(),
        makeConfig(3600)
      ).run();

      expect(create).not.toHaveBeenCalled();
      expect(updateCandidate).not.toHaveBeenCalled();
      expect(result.skippedCount).toBe(1);
      expect(result.candidates[0]).toMatchObject({
        candidateId: "cand-challenged",
        status: "skipped",
      });
    });

    it("does not treat two null scores as a tie that finalizes", async () => {
      const { prisma, create, updateCandidate } = runChallenged(null, {
        id: "competitor-1",
        confidenceScore: null,
      });

      const result = await new FinalizationJob(
        prisma,
        makeLogger(),
        makeConfig(3600)
      ).run();

      expect(create).not.toHaveBeenCalled();
      expect(updateCandidate).not.toHaveBeenCalled();
      expect(result.skippedCount).toBe(1);
      expect(result.candidates[0]).toMatchObject({
        candidateId: "cand-challenged",
        status: "skipped",
      });
    });

    it("does not treat a null own score as zero against a real competing score", async () => {
      // The competitor has a real, positive score and this candidate's own
      // score is null — not a defined decimal — so this must be inconclusive
      // rather than silently upheld as if null were 0.
      const { prisma, create, updateCandidate } = runChallenged(null, {
        id: "competitor-1",
        confidenceScore: 0.5,
      });

      const result = await new FinalizationJob(
        prisma,
        makeLogger(),
        makeConfig(3600)
      ).run();

      expect(create).not.toHaveBeenCalled();
      expect(updateCandidate).not.toHaveBeenCalled();
      expect(result.skippedCount).toBe(1);
    });

    it("denies the challenge when there is no competing PROPOSED row (documented product rule)", async () => {
      const { prisma, create, updateCandidate } = runChallenged(0.5, null);

      const result = await new FinalizationJob(
        prisma,
        makeLogger(),
        makeConfig(3600)
      ).run();

      expect(create).toHaveBeenCalled();
      expect(updateCandidate).toHaveBeenCalledWith({
        where: { id: "cand-challenged" },
        data: { status: "ACCEPTED" },
      });
      expect(result.candidates[0]).toMatchObject({
        candidateId: "cand-challenged",
        status: "finalized",
      });
    });
  });
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
        // Allow only 150 ms → first candidate (200 ms) completes, then the
        // pre-iteration guard blocks the remaining candidates.
        const job = new FinalizationJob(prisma, logger, {
          challengeWindowSeconds: 3600,
          maxRunMs: 150,
        });

        const result = await job.run();

        // Only the first candidate was processed before the guard triggered
        expect(result.finalizedCount).toBe(1);
        expect(result.totalCandidates).toBe(3);
        expect(logger.warn).toHaveBeenCalledWith(
          "Finalization job exceeded maxRunMs, stopping early",
          expect.objectContaining({ maxRunMs: 150 })
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

  describe("challenge adjudication compares Decimal confidence scores, not Number() (#1547)", () => {
    function makeChallengeTx(competingConfidenceScore: Decimal | null) {
      const create = vi.fn().mockResolvedValue({ id: "resolution-1" });
      const marketUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const updateCandidate = vi.fn().mockResolvedValue({});
      const positionUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
      const auditLogCreate = vi.fn().mockResolvedValue({});
      const queryRaw = vi
        .fn()
        .mockResolvedValue([{ id: "locked-row", status: "CHALLENGED" }]);
      const findFirst = vi.fn().mockResolvedValue(
        competingConfidenceScore === null
          ? null
          : { id: "competing-1", confidenceScore: competingConfidenceScore }
      );

      const tx = {
        resolution: { create },
        market: { updateMany: marketUpdateMany },
        resolutionCandidate: { update: updateCandidate, findFirst },
        userPosition: { updateMany: positionUpdateMany },
        resolutionAuditLog: { create: auditLogCreate },
        $queryRaw: queryRaw,
      };

      return { tx, create, updateCandidate, findFirst, auditLogCreate };
    }

    function makePrismaForTx(
      candidates: FinalizationCandidate[],
      tx: Record<string, unknown>
    ) {
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            await fn(tx)
        );
      return {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;
    }

    it("upholds the challenge when the competing score is a greater Decimal that Number() would round down to equal", async () => {
      // Both values collapse to the exact same double once passed through
      // Number(): the pre-#1547 bug compared them as equal (so the
      // challenge was never upheld) even though the competing score is
      // strictly greater as a Decimal.
      const challengeScore = new Decimal("0.10");
      const competingScore = new Decimal("0.10000000000000002");
      expect(Number(competingScore.toString())).toBe(
        Number(challengeScore.toString())
      );
      expect(competingScore.greaterThan(challengeScore)).toBe(true);

      const candidate = makeCandidate({
        id: "cand-challenged",
        marketId: "mkt-1",
        confidenceScore: challengeScore,
      });
      const { tx, updateCandidate, auditLogCreate, create } =
        makeChallengeTx(competingScore);
      const prisma = makePrismaForTx([candidate], tx);

      await new FinalizationJob(prisma, makeLogger(), makeConfig(3600)).run();

      // Challenge upheld: this candidate is rejected, not accepted, and no
      // Resolution/market update happens for it.
      expect(updateCandidate).toHaveBeenCalledWith({
        where: { id: "cand-challenged" },
        data: { status: "REJECTED" },
      });
      expect(auditLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          candidateId: "cand-challenged",
          marketId: "mkt-1",
          action: "ADJUDICATE_CHALLENGE",
          beforeStatus: "CHALLENGED",
          afterStatus: "REJECTED",
        }),
      });
      expect(create).not.toHaveBeenCalled();
    });

    it("finalizes the challenged candidate when no competing score is strictly greater", async () => {
      const score = new Decimal("0.75");
      const candidate = makeCandidate({
        id: "cand-challenged-2",
        marketId: "mkt-2",
        confidenceScore: score,
      });
      // Competing score is equal, not greater — the challenge is denied.
      const { tx, create, updateCandidate } = makeChallengeTx(
        new Decimal("0.75")
      );
      const prisma = makePrismaForTx([candidate], tx);

      await new FinalizationJob(prisma, makeLogger(), makeConfig(3600)).run();

      expect(create).toHaveBeenCalled();
      expect(updateCandidate).toHaveBeenCalledWith({
        where: { id: "cand-challenged-2" },
        data: { status: "ACCEPTED" },
      });
    });

    it("treats a null confidence score as zero on both sides of the comparison", async () => {
      const candidate = makeCandidate({
        id: "cand-challenged-3",
        marketId: "mkt-3",
        confidenceScore: null,
      });
      // No competing candidate at all — nothing to compare against.
      const { tx, create, updateCandidate } = makeChallengeTx(null);
      const prisma = makePrismaForTx([candidate], tx);

      await new FinalizationJob(prisma, makeLogger(), makeConfig(3600)).run();

      expect(create).toHaveBeenCalled();
      expect(updateCandidate).toHaveBeenCalledWith({
        where: { id: "cand-challenged-3" },
        data: { status: "ACCEPTED" },
      });
    });
  });

  describe("clock-skew tolerance for the challenge window (#1546)", () => {
    const FIXED_NOW = new Date("2026-01-01T01:00:00.000Z");

    afterEach(() => {
      vi.useRealTimers();
    });

    it("skips a candidate whose window closed less than the tolerance ago", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);

      const challengeWindowSeconds = 3600;
      const clockSkewToleranceMs = 5000;
      // The window closed 1 ms ago by challengeWindowSeconds alone — a
      // pre-#1546 host clock would finalize this immediately.
      const createdAt = new Date(
        FIXED_NOW.getTime() - challengeWindowSeconds * 1000 - 1
      );
      const candidate = makeCandidate({
        id: "cand-skew",
        marketId: "mkt-skew",
        createdAt,
      });
      const prisma = makePrisma([candidate]);
      const logger = makeLogger();

      const result = await new FinalizationJob(prisma, logger, {
        challengeWindowSeconds,
        clockSkewToleranceMs,
      }).run();

      expect(result.finalizedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(result.candidates[0]).toMatchObject({
        candidateId: "cand-skew",
        marketId: "mkt-skew",
        status: "skipped",
      });
    });

    it("still finalizes once both challengeWindowSeconds and the tolerance have elapsed", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);

      const challengeWindowSeconds = 3600;
      const clockSkewToleranceMs = 5000;
      const createdAt = new Date(
        FIXED_NOW.getTime() -
          challengeWindowSeconds * 1000 -
          clockSkewToleranceMs -
          1
      );
      const candidate = makeCandidate({
        id: "cand-skew-2",
        marketId: "mkt-skew-2",
        createdAt,
      });
      const prisma = makePrisma([candidate]);

      const result = await new FinalizationJob(prisma, makeLogger(), {
        challengeWindowSeconds,
        clockSkewToleranceMs,
      }).run();

      expect(result.finalizedCount).toBe(1);
      expect(result.candidates[0]).toMatchObject({
        candidateId: "cand-skew-2",
        marketId: "mkt-skew-2",
        status: "finalized",
      });
    });

    it("defaults clockSkewToleranceMs to 0 when omitted, preserving prior behavior", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);

      const challengeWindowSeconds = 3600;
      const createdAt = new Date(
        FIXED_NOW.getTime() - challengeWindowSeconds * 1000 - 1
      );
      const candidate = makeCandidate({
        id: "cand-no-skew-config",
        marketId: "mkt-no-skew-config",
        createdAt,
      });
      const prisma = makePrisma([candidate]);

      // No clockSkewToleranceMs supplied — same as before #1546.
      const result = await new FinalizationJob(
        prisma,
        makeLogger(),
        makeConfig(challengeWindowSeconds)
      ).run();

      expect(result.finalizedCount).toBe(1);
      expect(result.candidates[0]).toMatchObject({
        candidateId: "cand-no-skew-config",
        status: "finalized",
      });
    });
  });
});
