import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import { lockResolutionCandidate } from "./resolutionLock.js";

/**
 * Thrown when a challenge is submitted for a candidate that either doesn't
 * exist, or is no longer PROPOSED (already finalized, already challenged,
 * or rejected). Distinguishes "not found" from "illegal transition" so
 * callers can map to the right HTTP status once this is wired to a route.
 */
export class ChallengeNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(candidateId: string) {
    super(`ResolutionCandidate ${candidateId} not found`);
    this.name = "ChallengeNotFoundError";
  }
}

export class IllegalChallengeTransitionError extends Error {
  readonly statusCode = 409;
  constructor(candidateId: string, actualStatus: string) {
    super(
      `Cannot challenge candidate ${candidateId}: status is ${actualStatus}, not PROPOSED. ` +
        `Either it was already finalized (challenge window is closed and won the race) ` +
        `or already challenged/rejected.`
    );
    this.name = "IllegalChallengeTransitionError";
  }
}

export interface ChallengeResult {
  candidateId: string;
  marketId: string;
  status: "CHALLENGED";
}

/**
 * Challenge/dispute write path for a ResolutionCandidate.
 *
 * Takes the exact same lock order as FinalizationJob (see resolutionLock.ts):
 * `SELECT ... FOR UPDATE` on the single `resolution_candidates` row by id,
 * then re-checks status before writing. This is what makes finalize and
 * challenge mutually exclusive — Postgres serializes the two transactions
 * on the row lock, so whichever commits first wins and the other observes
 * the committed status and rejects the illegal transition instead of
 * silently racing.
 *
 * Must be called strictly before the finalization job's transaction commits
 * for the same candidate; once that commits, this always loses the race
 * (status is ACCEPTED, not PROPOSED) and throws
 * IllegalChallengeTransitionError — it never appends CHALLENGED after the
 * fact.
 */
export async function challengeResolutionCandidate(
  prisma: PrismaClient,
  logger: ILogger,
  candidateId: string,
  actor: string
): Promise<ChallengeResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await lockResolutionCandidate(tx, candidateId);

    if (!locked) {
      throw new ChallengeNotFoundError(candidateId);
    }

    if (locked.status !== "PROPOSED") {
      throw new IllegalChallengeTransitionError(candidateId, locked.status);
    }

    const candidate = await tx.resolutionCandidate.update({
      where: { id: candidateId },
      data: { status: "CHALLENGED" },
      select: { id: true, marketId: true },
    });

    await tx.resolutionAuditLog.create({
      data: {
        candidateId: candidate.id,
        marketId: candidate.marketId,
        action: "CHALLENGE",
        beforeStatus: "PROPOSED",
        afterStatus: "CHALLENGED",
        actor,
      },
    });

    logger.info("Resolution candidate challenged", {
      candidateId: candidate.id,
      marketId: candidate.marketId,
      actor,
    });

    return {
      candidateId: candidate.id,
      marketId: candidate.marketId,
      status: "CHALLENGED" as const,
    };
  });
}
