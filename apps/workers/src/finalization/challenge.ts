import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { ILogger } from "@vatix/shared/logger.js";
import { lockResolutionCandidateOrThrow } from "./resolutionLock.js";

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

/**
 * Thrown when the caller is not entitled to challenge a resolution
 * candidate (see #1544: previously any caller could put an arbitrary
 * string into the audit trail with no authorization at all).
 */
export class UnauthorizedChallengeActorError extends Error {
  readonly statusCode = 403;
  constructor(candidateId: string) {
    super(
      `Actor is not authorized to challenge candidate ${candidateId}: ` +
        `must be a configured admin address, the market's oracle address, ` +
        `or a challenger with posted collateral for the market.`
    );
    this.name = "UnauthorizedChallengeActorError";
  }
}

export interface ChallengeResult {
  candidateId: string;
  marketId: string;
  status: "CHALLENGED";
}

/**
 * Parses CHALLENGE_ADMIN_ADDRESSES (comma-separated Stellar addresses) on
 * every call rather than once at module load, so tests can set the
 * environment variable per-case and production can rotate it without a
 * process restart picking up a stale cached set.
 */
function getAdminActorAddresses(): Set<string> {
  return new Set(
    (process.env.CHALLENGE_ADMIN_ADDRESSES ?? "")
      .split(",")
      .map((address) => address.trim())
      .filter((address) => address.length > 0)
  );
}

/**
 * Authorizes the actor attempting to challenge a resolution candidate.
 *
 * An actor may challenge only if it is one of:
 *   - a configured admin address (CHALLENGE_ADMIN_ADDRESSES), or
 *   - the market's oracle address (Market.oracleAddress), or
 *   - a challenger that has posted collateral ("a bond") for the market
 *     (CollateralDeposit.account for that marketId).
 *
 * Deliberately runs on plain (non-locking) reads, and strictly before
 * {@link lockResolutionCandidateOrThrow} is ever called, so a rejected
 * caller never acquires the `resolution_candidates` row lock.
 *
 * If the candidate itself doesn't resolve to a market (unknown/removed
 * candidate id), authorization is skipped here and the existing locking
 * path reports ChallengeNotFoundError — this avoids leaking authorization
 * decisions for a row that doesn't exist.
 */
async function assertAuthorizedChallenger(
  prisma: PrismaClient,
  candidateId: string,
  actor: string
): Promise<void> {
  if (!actor || typeof actor !== "string" || actor.trim().length === 0) {
    throw new UnauthorizedChallengeActorError(candidateId);
  }

  if (getAdminActorAddresses().has(actor)) {
    return;
  }

  const candidate = await prisma.resolutionCandidate.findUnique({
    where: { id: candidateId },
    select: { marketId: true },
  });

  if (!candidate) {
    return;
  }

  const market = await prisma.market.findUnique({
    where: { id: candidate.marketId },
    select: { oracleAddress: true },
  });

  if (market && market.oracleAddress === actor) {
    return;
  }

  const bond = await prisma.collateralDeposit.findFirst({
    where: { marketId: candidate.marketId, account: actor },
    select: { id: true },
  });

  if (bond) {
    return;
  }

  throw new UnauthorizedChallengeActorError(candidateId);
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
  await assertAuthorizedChallenger(prisma, candidateId, actor);

  return prisma.$transaction(async (tx) => {
    const locked = await lockResolutionCandidateOrThrow(tx, candidateId, logger);

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
