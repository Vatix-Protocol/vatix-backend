import { describe, it, expect, vi } from "vitest";
import { FinalizationJob } from "./job.js";
import type { FinalizationCandidate } from "./job.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";

// ---------------------------------------------------------------------------
// #1555 — a candidate created inside the challenge window is skipped, not
// finalized.
//
// "Now" is pinned with the job's injected `now` clock, so the test neither
// sleeps nor fakes global timers.
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-06-01T12:00:00.000Z");
const WINDOW_SECONDS = 60;

function makeLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as ILogger;
}

/**
 * Prisma double whose transaction records every write, so the test can show
 * that nothing moved the candidate to ACCEPTED.
 */
function makePrisma(candidates: FinalizationCandidate[]) {
  const candidateUpdate = vi.fn().mockResolvedValue({});
  const resolutionCreate = vi.fn().mockResolvedValue({ id: "resolution-1" });
  const marketUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    resolution: { create: resolutionCreate },
    market: { updateMany: marketUpdateMany },
    resolutionCandidate: {
      update: candidateUpdate,
      findFirst: vi.fn().mockResolvedValue(null),
    },
    userPosition: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    resolutionAuditLog: { create: vi.fn().mockResolvedValue({}) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "locked", status: "PROPOSED" }]),
  };

  // Returns the candidate even though a real query would filter it out, so
  // the per-candidate window check is exercised as well as the query cutoff.
  const findMany = vi.fn().mockResolvedValue(candidates);
  const $transaction = vi
    .fn()
    .mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx)
    );

  const prisma = {
    resolutionCandidate: { findMany },
    $transaction,
  } as unknown as PrismaClient;

  return {
    prisma,
    findMany,
    $transaction,
    candidateUpdate,
    resolutionCreate,
    marketUpdateMany,
  };
}

describe("FinalizationJob — candidate inside the challenge window (#1555)", () => {
  it("skips a candidate created 10s ago under a 60s window", async () => {
    const young: FinalizationCandidate = {
      id: "young",
      marketId: "market-young",
      proposedOutcome: true,
      source: "chainlink",
      status: "PROPOSED",
      createdAt: new Date(NOW_MS - 10_000), // created 10 seconds ago
    };
    const {
      prisma,
      findMany,
      $transaction,
      candidateUpdate,
      resolutionCreate,
      marketUpdateMany,
    } = makePrisma([young]);

    const job = new FinalizationJob(prisma, makeLogger(), {
      challengeWindowSeconds: WINDOW_SECONDS,
      now: () => NOW_MS,
    });
    const result = await job.run();

    // Selection cutoff is now - challengeWindowSeconds; the young candidate
    // was created after it.
    expect(findMany).toHaveBeenCalledTimes(1);
    const cutoff: Date = findMany.mock.calls[0][0].where.createdAt.lte;
    expect(cutoff.getTime()).toBe(NOW_MS - WINDOW_SECONDS * 1000);
    expect(young.createdAt.getTime()).toBeGreaterThan(cutoff.getTime());

    // Skipped by the per-candidate check, not finalized.
    expect(result.totalCandidates).toBe(1);
    expect(result.finalizedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.erroredCount).toBe(0);
    expect(result.candidates).toEqual([
      expect.objectContaining({ candidateId: "young", status: "skipped" }),
    ]);

    // Never ACCEPTED: no transaction opened, no candidate status write, and
    // no resolution or market write.
    expect($transaction).not.toHaveBeenCalled();
    expect(candidateUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACCEPTED" }),
      })
    );
    expect(resolutionCreate).not.toHaveBeenCalled();
    expect(marketUpdateMany).not.toHaveBeenCalled();
  });

  it("finalizes the same candidate once the injected clock passes the window (control)", async () => {
    const candidate: FinalizationCandidate = {
      id: "aged",
      marketId: "market-aged",
      proposedOutcome: true,
      source: "chainlink",
      status: "PROPOSED",
      createdAt: new Date(NOW_MS - 10_000),
    };
    const { prisma, candidateUpdate } = makePrisma([candidate]);

    // 61 seconds later the 60-second window has closed.
    const job = new FinalizationJob(prisma, makeLogger(), {
      challengeWindowSeconds: WINDOW_SECONDS,
      now: () => NOW_MS + 51_000,
    });
    const result = await job.run();

    expect(result.finalizedCount).toBe(1);
    expect(candidateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACCEPTED" }),
      })
    );
  });
});
