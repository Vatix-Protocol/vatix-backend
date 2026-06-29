import { describe, it, expect, vi } from "vitest";
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

function makePrisma(
  candidates: FinalizationCandidate[] = [],
  resolutionError: boolean = false
) {
  const create = vi.fn().mockResolvedValue({ id: "resolution-1" });
  const update = vi.fn().mockResolvedValue({});
  const updateMany = vi.fn().mockResolvedValue({ count: 2 });

  const transaction = vi
    .fn()
    .mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          resolution: { create },
          market: { update },
          resolutionCandidate: { update },
          userPosition: { updateMany },
        };
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
      const create = vi.fn().mockResolvedValue({ id: "resolution-1" });
      const update = vi.fn().mockResolvedValue({});
      const updateMany = vi.fn().mockResolvedValue({ count: 2 });
      const updateCandidate = vi.fn().mockResolvedValue({});
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
            const tx = {
              resolution: { create },
              market: { update },
              resolutionCandidate: { update: updateCandidate },
              userPosition: { updateMany },
            };
            return await fn(tx);
          }
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

    it("updates Market status to RESOLVED and sets outcome", async () => {
      const candidates = [
        makeCandidate({ marketId: "mkt-1", proposedOutcome: false }),
      ];
      const create = vi.fn().mockResolvedValue({ id: "resolution-1" });
      const update = vi.fn().mockResolvedValue({});
      const updateMany = vi.fn().mockResolvedValue({ count: 2 });
      const updateCandidate = vi.fn().mockResolvedValue({});
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
            const tx = {
              resolution: { create },
              market: { update },
              resolutionCandidate: { update: updateCandidate },
              userPosition: { updateMany },
            };
            return await fn(tx);
          }
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const job = new FinalizationJob(prisma, makeLogger(), makeConfig(3600));
      await job.run();

      expect(update).toHaveBeenCalledWith({
        where: { id: "mkt-1" },
        data: expect.objectContaining({
          status: "RESOLVED",
          outcome: false,
        }),
      });
    });

    it("updates resolution candidate status to ACCEPTED", async () => {
      const candidates = [makeCandidate({ id: "cand-1" })];
      const create = vi.fn().mockResolvedValue({ id: "resolution-1" });
      const update = vi.fn().mockResolvedValue({});
      const updateMany = vi.fn().mockResolvedValue({ count: 2 });
      const updateCandidate = vi.fn().mockResolvedValue({});
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
            const tx = {
              resolution: { create },
              market: { update },
              resolutionCandidate: { update: updateCandidate },
              userPosition: { updateMany },
            };
            return await fn(tx);
          }
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
      const create = vi.fn().mockResolvedValue({ id: "resolution-1" });
      const update = vi.fn().mockResolvedValue({});
      const updateMany = vi.fn().mockResolvedValue({ count: 3 });
      const updateCandidate = vi.fn().mockResolvedValue({});
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
            const tx = {
              resolution: { create },
              market: { update },
              resolutionCandidate: { update: updateCandidate },
              userPosition: { updateMany },
            };
            return await fn(tx);
          }
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const job = new FinalizationJob(prisma, makeLogger(), makeConfig(3600));
      await job.run();

      expect(updateMany).toHaveBeenCalledWith({
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
      const create = vi.fn().mockResolvedValue({ id: "resolution-1" });
      const update = vi.fn().mockResolvedValue({});
      const updateMany = vi.fn().mockResolvedValue({ count: 2 });
      const updateCandidate = vi.fn().mockResolvedValue({});
      const transaction = vi
        .fn()
        .mockImplementation(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
            const tx = {
              resolution: { create },
              market: { update },
              resolutionCandidate: { update: updateCandidate },
              userPosition: { updateMany },
            };
            return await fn(tx);
          }
        );
      const prisma = {
        resolutionCandidate: {
          findMany: vi.fn().mockResolvedValue(candidates),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;

      const job = new FinalizationJob(prisma, makeLogger(), makeConfig(3600));
      await job.run();

      expect(update).toHaveBeenCalledWith({
        where: { id: candidates[0].marketId },
        data: expect.objectContaining({
          resolutionTime: expect.any(Date),
        }),
      });
    });
  });

  describe("error handling", () => {
    it("captures error per candidate and continues processing others", async () => {
      const candidates = [
        makeCandidate({ id: "cand-1", marketId: "mkt-1" }),
        makeCandidate({ id: "cand-2", marketId: "mkt-2" }),
      ];
      const createOk = vi.fn().mockResolvedValue({ id: "resolution-1" });
      const updateOk = vi.fn().mockResolvedValue({});
      const updateManyOk = vi.fn().mockResolvedValue({ count: 2 });
      const updateCandidateOk = vi.fn().mockResolvedValue({});
      const transaction = vi
        .fn()
        .mockImplementationOnce(
          async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
            const tx = {
              resolution: { create: createOk },
              market: { update: updateOk },
              resolutionCandidate: { update: updateCandidateOk },
              userPosition: { updateMany: updateManyOk },
            };
            return await fn(tx);
          }
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
});
