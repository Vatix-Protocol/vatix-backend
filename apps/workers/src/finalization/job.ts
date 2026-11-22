import { Decimal } from "@prisma/client/runtime/client.js";
import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import type {
  FinalizationJobResult,
  FinalizationCandidateResult,
} from "./types.js";
import { isChallengeWindowOpen } from "../../../../src/oracle/challengeWindow.js";
import { RESOLVABLE_MARKET_STATUSES } from "../../../../packages/shared/src/marketLifecycle.js";
import { lockResolutionCandidateOrThrow } from "./resolutionLock.js";

/** Zero confidence, used when a candidate has no reported score. */
const ZERO_CONFIDENCE = new Decimal(0);

/**
 * Configuration for a single FinalizationJob run.
 * Passed to the constructor so callers never deal with raw primitives.
 */
export interface FinalizationJobConfig {
  /** How long (in seconds) a resolution candidate must sit in PROPOSED
   *  before it is eligible for finalization. Must be >= 0. */
  challengeWindowSeconds: number;
  /**
   * Maximum wall-clock time (ms) the job is allowed to run before it stops
   * processing further candidates and returns a partial result.  This
   * prevents a large backlog from blocking the scheduler for an unbounded
   * amount of time.  Set to 0 to disable (no time limit).  Default: 0.
   */
  maxRunMs?: number;
  /**
   * Grace period (ms) subtracted from the challenge-window cutoff before
   * comparing against a candidate's `createdAt` (#1546). Guards against the
   * host container clock running fast relative to the Stellar ledger: if the
   * host clock is ahead, `Date.now()` can cross the challenge-window cutoff
   * before the ledger has actually held the candidate in PROPOSED for
   * `challengeWindowSeconds`, finalizing it early. A candidate is only
   * eligible once `createdAt <= now - challengeWindowSeconds*1000 - tolerance`.
   * Uses the same tolerance the expiry worker applies to `endTime`
   * (`resolveClockSkewToleranceMs` in `@vatix/shared/marketLifecycle`), so
   * both paths agree on how much the host clock is allowed to drift.
   * Defaults to 0 (no tolerance) when omitted.
   */
  clockSkewToleranceMs?: number;
}

export interface FinalizationCandidate {
  id: string;
  marketId: string;
  proposedOutcome: boolean;
  source: string;
  status: "PROPOSED" | "CHALLENGED";
  /**
   * Decimal(5,4) column, kept as a Prisma `Decimal` all the way through the
   * adjudication comparison (#1547). Converting it with `Number()` before
   * comparing can make two close-but-distinct scores (e.g. `0.10` and
   * `0.10000000000000002`) compare equal, or sort differently from the
   * `orderBy: confidenceScore` the competing-candidate query just used.
   */
  confidenceScore: Decimal | null;
  createdAt: Date;
}

export class FinalizationValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "FinalizationValidationError";
  }
}

/**
 * Thrown inside the finalization transaction when the target market was
 * canceled or soft-deleted after the candidate query ran (e.g. an admin
 * canceled the market during the challenge window). Rolls back the
 * transaction and is translated into a "skipped" result rather than
 * "errored", since this is expected concurrent state, not a failure.
 */
class MarketNotEligibleError extends Error {
  constructor(marketId: string) {
    super(`Market ${marketId} is canceled or deleted; skipping finalization`);
    this.name = "MarketNotEligibleError";
  }
}

/**
 * Thrown inside the finalization transaction when the row lock reveals the
 * candidate is no longer PROPOSED — e.g. a challenge write committed after
 * the outer `findMany` ran but before this transaction acquired the lock.
 * Rolls back and is translated into "skipped", not "errored": losing this
 * race is expected, correct behavior, not a failure.
 */
class CandidateNotEligibleError extends Error {
  constructor(candidateId: string, actualStatus: string) {
    super(
      `Candidate ${candidateId} is no longer PROPOSED (status=${actualStatus}); skipping finalization`
    );
    this.name = "CandidateNotEligibleError";
  }
}

export class FinalizationJob {
  private readonly challengeWindowSeconds: number;
  private readonly maxRunMs: number;
  private readonly clockSkewToleranceMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: ILogger,
    config: FinalizationJobConfig
  ) {
    this.challengeWindowSeconds = config.challengeWindowSeconds;
    this.maxRunMs = config.maxRunMs ?? 0;
    this.clockSkewToleranceMs = config.clockSkewToleranceMs ?? 0;
  }

  async run(): Promise<FinalizationJobResult> {
    if (
      !Number.isFinite(this.challengeWindowSeconds) ||
      this.challengeWindowSeconds < 0
    ) {
      throw new FinalizationValidationError(
        `challengeWindowSeconds must be a non-negative number, got: ${this.challengeWindowSeconds}`
      );
    }

    const startedAt = new Date();
    // Subtracting the tolerance as well as the window makes the cutoff
    // stricter (further in the past): a fast host clock cannot shrink the
    // effective challenge window below `challengeWindowSeconds` (#1546).
    const windowCutoff = new Date(
      Date.now() - this.challengeWindowSeconds * 1000 - this.clockSkewToleranceMs
    );

    this.logger.info("Finalization job started", {
      challengeWindowSeconds: this.challengeWindowSeconds,
      clockSkewToleranceMs: this.clockSkewToleranceMs,
      windowCutoff: windowCutoff.toISOString(),
    });

    let candidates: FinalizationCandidate[];

    try {
      candidates = await this.prisma.resolutionCandidate.findMany({
        where: {
          status: { in: ["PROPOSED", "CHALLENGED"] },
          createdAt: { lte: windowCutoff },
          market: {
            // Only markets in a lifecycle state that may still transition to
            // RESOLVED are finalization candidates.
            status: { in: [...RESOLVABLE_MARKET_STATUSES] },
            deletedAt: null,
          },
        },
        select: {
          id: true,
          marketId: true,
          proposedOutcome: true,
          source: true,
          status: true,
          confidenceScore: true,
          createdAt: true,
        },
      });
    } catch (error) {
      this.logger.error("Finalization job failed to query candidates", {
        error: error instanceof Error ? error.message : String(error),
      });
      const completedAt = new Date();
      return {
        totalCandidates: 0,
        finalizedCount: 0,
        skippedCount: 0,
        erroredCount: 0,
        candidates: [],
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
      };
    }

    this.logger.info("Finalization job selected candidates", {
      count: candidates.length,
    });

    const results: FinalizationCandidateResult[] = [];

    for (const candidate of candidates) {
      // Elapsed-time guard: stop processing if the job has exceeded maxRunMs.
      // This prevents a large backlog from monopolising the scheduler slot.
      if (
        this.maxRunMs > 0 &&
        Date.now() - startedAt.getTime() >= this.maxRunMs
      ) {
        this.logger.warn("Finalization job exceeded maxRunMs, stopping early", {
          maxRunMs: this.maxRunMs,
          processedSoFar: results.length,
          remainingCandidates: candidates.length - results.length,
        });
        break;
      }

      // ── Challenge window verification ──────────────────────────────────
      // Explicitly check that the candidate's challenge window has closed
      // before finalizing.  This is a defense-in-depth check against clock
      // skew or concurrent schedule edge cases; the query-level
      // `createdAt: { lte: windowCutoff }` filter is the primary gate.
      // `now` is pushed back by the same tolerance as the query cutoff
      // (#1546): a fast host clock must not make this check pass any sooner
      // than the real ledger clock would.
      if (
        isChallengeWindowOpen(
          candidate.createdAt,
          this.challengeWindowSeconds,
          new Date(Date.now() - this.clockSkewToleranceMs)
        )
      ) {
        this.logger.info("Candidate still within challenge window — skipping", {
          candidateId: candidate.id,
          marketId: candidate.marketId,
          createdAt: candidate.createdAt.toISOString(),
          challengeWindowSeconds: this.challengeWindowSeconds,
        });

        results.push({
          candidateId: candidate.id,
          marketId: candidate.marketId,
          proposedOutcome: candidate.proposedOutcome,
          status: "skipped",
        });
        continue;
      }

      this.logger.info("Finalization candidate eligible", {
        candidateId: candidate.id,
        marketId: candidate.marketId,
        proposedOutcome: candidate.proposedOutcome,
        source: candidate.source,
        createdAt: candidate.createdAt.toISOString(),
      });

      try {
        const txState = { challengeRejected: false };
        await this.prisma.$transaction(async (tx) => {
          const now = new Date();

          // ── Mutual exclusion with the challenge/dispute path ────────────
          // Lock the candidate row before touching anything else. A
          // concurrent challenge write takes the same lock (see
          // resolutionLock.ts); whichever transaction commits first wins,
          // and the loser sees the post-commit status here and aborts.
          const locked = await lockResolutionCandidateOrThrow(
            tx,
            candidate.id,
            this.logger
          );

          if (
            !locked ||
            (locked.status !== "PROPOSED" && locked.status !== "CHALLENGED")
          ) {
            throw new CandidateNotEligibleError(
              candidate.id,
              locked?.status ?? "MISSING"
            );
          }

          // ── Handle CHALLENGED candidates ────────────────────────────────
          // Adjudicate challenges by checking if a competing PROPOSED candidate
          // with higher confidence exists. If so, reject this candidate (challenge
          // upheld). Otherwise, accept it and finalize (challenge denied).
          if (locked.status === "CHALLENGED") {
            const competing = await tx.resolutionCandidate.findFirst({
              where: {
                marketId: candidate.marketId,
                status: "PROPOSED",
                id: { not: candidate.id },
              },
              orderBy: { confidenceScore: "desc" },
              select: { id: true, confidenceScore: true },
            });

            // Decimal(5,4) columns compared as Decimal, not as JavaScript
            // numbers (#1547): converting with `Number()` first can make two
            // close-but-distinct scores compare equal, or sort differently
            // from the `orderBy: confidenceScore` the query above just used.
            const challengeScore = candidate.confidenceScore ?? ZERO_CONFIDENCE;
            const competingScore = competing?.confidenceScore ?? ZERO_CONFIDENCE;

            if (competing && competingScore.greaterThan(challengeScore)) {
              // Challenge upheld: reject this candidate
              await tx.resolutionCandidate.update({
                where: { id: candidate.id },
                data: { status: "REJECTED" },
              });

              await tx.resolutionAuditLog.create({
                data: {
                  candidateId: candidate.id,
                  marketId: candidate.marketId,
                  action: "ADJUDICATE_CHALLENGE",
                  beforeStatus: "CHALLENGED",
                  afterStatus: "REJECTED",
                  actor: "finalization-worker",
                },
              });

              this.logger.info("Challenged candidate rejected", {
                candidateId: candidate.id,
                marketId: candidate.marketId,
                reason: "competing proposal with higher confidence",
                competingCandidateId: competing.id,
              });

              txState.challengeRejected = true;
              return;
            }
          }

          // ── Finalize PROPOSED or CHALLENGED (challenge denied) ──────────
          await tx.resolution.create({
            data: {
              marketId: candidate.marketId,
              outcome: candidate.proposedOutcome,
              finalizedAt: now,
              provenance: candidate.source,
            },
          });

          const marketUpdate = await tx.market.updateMany({
            where: {
              id: candidate.marketId,
              status: { in: [...RESOLVABLE_MARKET_STATUSES] },
              deletedAt: null,
            },
            data: {
              status: "RESOLVED",
              outcome: candidate.proposedOutcome,
              resolutionTime: now,
            },
          });

          if (marketUpdate.count === 0) {
            throw new MarketNotEligibleError(candidate.marketId);
          }

          const beforeStatus = locked.status;
          await tx.resolutionCandidate.update({
            where: { id: candidate.id },
            data: { status: "ACCEPTED" },
          });

          await tx.userPosition.updateMany({
            where: { marketId: candidate.marketId },
            data: { isSettled: true },
          });

          await tx.resolutionAuditLog.create({
            data: {
              candidateId: candidate.id,
              marketId: candidate.marketId,
              action: "FINALIZE",
              beforeStatus,
              afterStatus: "ACCEPTED",
              actor: "finalization-worker",
            },
          });
        });

        if (!txState.challengeRejected) {
          results.push({
            candidateId: candidate.id,
            marketId: candidate.marketId,
            proposedOutcome: candidate.proposedOutcome,
            status: "finalized",
          });

          this.logger.info("Finalization candidate finalized", {
            candidateId: candidate.id,
            marketId: candidate.marketId,
            proposedOutcome: candidate.proposedOutcome,
          });
        } else {
          results.push({
            candidateId: candidate.id,
            marketId: candidate.marketId,
            proposedOutcome: candidate.proposedOutcome,
            status: "finalized",
          });
        }
      } catch (error) {
        if (error instanceof MarketNotEligibleError) {
          results.push({
            candidateId: candidate.id,
            marketId: candidate.marketId,
            proposedOutcome: candidate.proposedOutcome,
            status: "skipped",
          });

          this.logger.info(
            "Finalization candidate skipped: market canceled or deleted",
            {
              candidateId: candidate.id,
              marketId: candidate.marketId,
            }
          );
        } else if (error instanceof CandidateNotEligibleError) {
          results.push({
            candidateId: candidate.id,
            marketId: candidate.marketId,
            proposedOutcome: candidate.proposedOutcome,
            status: "skipped",
          });

          this.logger.info(
            "Finalization candidate skipped: lost race to a concurrent challenge/status change",
            {
              candidateId: candidate.id,
              marketId: candidate.marketId,
              error: error.message,
            }
          );
        } else {
          const message =
            error instanceof Error ? error.message : String(error);

          results.push({
            candidateId: candidate.id,
            marketId: candidate.marketId,
            proposedOutcome: candidate.proposedOutcome,
            status: "errored",
            error: message,
          });

          this.logger.error("Finalization candidate failed", {
            candidateId: candidate.id,
            marketId: candidate.marketId,
            proposedOutcome: candidate.proposedOutcome,
            error: message,
          });
        }
      }
    }

    const completedAt = new Date();
    const finalizedCount = results.filter(
      (r) => r.status === "finalized"
    ).length;
    const erroredCount = results.filter((r) => r.status === "errored").length;
    const skippedCount = results.filter((r) => r.status === "skipped").length;

    this.logger.info("Finalization job complete", {
      eligible: candidates.length,
      finalized: finalizedCount,
      errored: erroredCount,
      skipped: skippedCount,
    });

    return {
      totalCandidates: candidates.length,
      finalizedCount,
      skippedCount,
      erroredCount,
      candidates: results,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
    };
  }
}
