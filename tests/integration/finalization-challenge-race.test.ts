/**
 * Integration test: finalization vs. challenge/dispute race.
 *
 * Finalization promotes a ResolutionCandidate past the challenge window;
 * challenging a candidate transitions it to CHALLENGED. Both paths write to
 * the same `resolution_candidates` row and must be mutually exclusive: a
 * late challenge racing the finalization tick must never both pay out a
 * Resolution *and* leave the candidate CHALLENGED (split-brain).
 *
 * Unlike the unit tests in apps/workers/src/finalization/job.test.ts (which
 * mock Prisma and only prove the code *calls* `SELECT ... FOR UPDATE`),
 * these tests run both writers concurrently against a real Postgres
 * instance so the row lock actually serializes them.
 *
 * Acceptance criteria under test:
 *  - Under concurrency, exactly one of finalize or challenge wins; never both.
 *  - No Resolution row for a candidate left in CHALLENGED.
 *  - Deterministic clock control at the challenge-window boundary.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { getTestPrismaClient, testUtils } from "../setup.js";
import {
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../helpers/test-database.js";
import { FinalizationJob } from "../../apps/workers/src/finalization/job.js";
import {
  challengeResolutionCandidate,
  IllegalChallengeTransitionError,
} from "../../apps/workers/src/finalization/challenge.js";
import type { ILogger } from "../../packages/shared/src/logger.js";

function silentLogger(): ILogger {
  const noop = () => undefined;
  const logger: ILogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

const WINDOW_SECONDS = 3600;

describe("Finalization vs. challenge race (DB-level locking)", () => {
  const prisma = getTestPrismaClient();

  beforeAll(async () => {
    await acquireDatabaseLock();
  });

  afterAll(async () => {
    await releaseDatabaseLock();
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  /** Creates a market + a PROPOSED candidate whose challenge window has just closed at `now`. */
  async function createEligibleCandidate(now: Date) {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const candidate = await prisma.resolutionCandidate.create({
      data: {
        marketId: market.id,
        proposedOutcome: true,
        source: "chainlink",
        operatorAddress: testUtils.generateStellarAddress(),
        status: "PROPOSED",
        // closesAt = createdAt + WINDOW_SECONDS === now -> window just closed.
        createdAt: new Date(now.getTime() - WINDOW_SECONDS * 1000),
      },
    });
    return { market, candidate };
  }

  async function assertNoSplitBrain(candidateId: string, marketId: string) {
    const candidate = await prisma.resolutionCandidate.findUniqueOrThrow({
      where: { id: candidateId },
    });
    const resolutions = await prisma.resolution.findMany({
      where: { marketId },
    });
    const auditEntries = await prisma.resolutionAuditLog.findMany({
      where: { candidateId },
    });

    // Exactly one winner: either ACCEPTED with a Resolution row, or
    // CHALLENGED with none. Never both, never neither.
    expect(["ACCEPTED", "CHALLENGED"]).toContain(candidate.status);
    if (candidate.status === "ACCEPTED") {
      expect(resolutions).toHaveLength(1);
    } else {
      // Core acceptance criterion: no Resolution row for a CHALLENGED candidate.
      expect(resolutions).toHaveLength(0);
    }
    // Exactly one win-path audit entry — the loser never got to write one.
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].action).toBe(
      candidate.status === "ACCEPTED" ? "FINALIZE" : "CHALLENGE"
    );

    return candidate;
  }

  it("exactly one of finalize-tick and challenge wins when raced at the exact window cutoff (repeated)", async () => {
    const now = new Date("2026-03-01T00:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);

    try {
      // Repeat with fresh candidates to shake out ordering-dependent bugs —
      // Promise.all races the two writers' actual connection/lock timing,
      // which varies run to run.
      for (let i = 0; i < 10; i++) {
        const { market, candidate } = await createEligibleCandidate(now);
        const job = new FinalizationJob(prisma, silentLogger(), {
          challengeWindowSeconds: WINDOW_SECONDS,
        });

        const [finalizeResult, challengeResult] = await Promise.allSettled([
          job.run(),
          challengeResolutionCandidate(
            prisma,
            silentLogger(),
            candidate.id,
            "disputer-1"
          ),
        ]);

        // Both calls resolve without throwing an unexpected error type —
        // the loser either gets a "skipped" result (finalize) or an
        // IllegalChallengeTransitionError (challenge), never a crash.
        expect(finalizeResult.status).toBe("fulfilled");
        if (challengeResult.status === "rejected") {
          expect(challengeResult.reason).toBeInstanceOf(
            IllegalChallengeTransitionError
          );
        }

        await assertNoSplitBrain(candidate.id, market.id);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("challenge submitted after finalize already committed is rejected — never appends CHALLENGED post-commit", async () => {
    const now = new Date("2026-03-01T00:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);

    try {
      const { market, candidate } = await createEligibleCandidate(now);
      const job = new FinalizationJob(prisma, silentLogger(), {
        challengeWindowSeconds: WINDOW_SECONDS,
      });

      const result = await job.run();
      expect(result.finalizedCount).toBe(1);

      await expect(
        challengeResolutionCandidate(
          prisma,
          silentLogger(),
          candidate.id,
          "disputer-1"
        )
      ).rejects.toThrow(IllegalChallengeTransitionError);

      await assertNoSplitBrain(candidate.id, market.id);

      const resolvedMarket = await prisma.market.findUniqueOrThrow({
        where: { id: market.id },
      });
      expect(resolvedMarket.status).toBe("RESOLVED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalize tick after a challenge already committed skips the candidate — no Resolution, market stays ACTIVE", async () => {
    const now = new Date("2026-03-01T00:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);

    try {
      const { market, candidate } = await createEligibleCandidate(now);

      await challengeResolutionCandidate(
        prisma,
        silentLogger(),
        candidate.id,
        "disputer-1"
      );

      const job = new FinalizationJob(prisma, silentLogger(), {
        challengeWindowSeconds: WINDOW_SECONDS,
      });
      const result = await job.run();

      expect(result.finalizedCount).toBe(0);
      // Already CHALLENGED candidates are excluded by the PROPOSED query gate,
      // so the job has nothing to skip inside the finalize path.
      expect(result.skippedCount).toBe(0);
      expect(result.erroredCount).toBe(0);
      expect(result.totalCandidates).toBe(0);

      await assertNoSplitBrain(candidate.id, market.id);

      const untouchedMarket = await prisma.market.findUniqueOrThrow({
        where: { id: market.id },
      });
      expect(untouchedMarket.status).toBe("ACTIVE");
    } finally {
      vi.useRealTimers();
    }
  });

  it("boundary: 1ms before window closes, finalize skips it (still open) but challenge still succeeds", async () => {
    const now = new Date("2026-03-01T00:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);

    try {
      const market = await testUtils.createTestMarket({ status: "ACTIVE" });
      const candidate = await prisma.resolutionCandidate.create({
        data: {
          marketId: market.id,
          proposedOutcome: true,
          source: "chainlink",
          operatorAddress: testUtils.generateStellarAddress(),
          status: "PROPOSED",
          // closesAt = createdAt + WINDOW_SECONDS = now + 1ms -> still open.
          createdAt: new Date(now.getTime() - WINDOW_SECONDS * 1000 + 1),
        },
      });

      const job = new FinalizationJob(prisma, silentLogger(), {
        challengeWindowSeconds: WINDOW_SECONDS,
      });

      const [finalizeResult, challenged] = await Promise.all([
        job.run(),
        challengeResolutionCandidate(
          prisma,
          silentLogger(),
          candidate.id,
          "disputer-1"
        ),
      ]);

      expect(finalizeResult.totalCandidates).toBe(0);
      expect(finalizeResult.candidates).toHaveLength(0);
      expect(challenged.status).toBe("CHALLENGED");

      await assertNoSplitBrain(candidate.id, market.id);
    } finally {
      vi.useRealTimers();
    }
  });
});
