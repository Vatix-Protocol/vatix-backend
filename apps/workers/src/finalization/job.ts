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
  /**
   * Clock used for the challenge-window cutoff, the per-candidate window
   * check, the maxRunMs guard and the finalization timestamps. Returns epoch
   * milliseconds. Defaults to `Date.now`; injectable so tests can pin "now"
   * without sleeping or faking global timers.
   */
  now?: () => number;
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
  private readonly now: () => number;

  /**
   * @throws {FinalizationValidationError} when `challengeWindowSeconds` is
   *   not a finite non-negative number, so a misconfigured worker fails at
   *   startup instead of on its first poll.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: ILogger,
    config: FinalizationJobConfig
  ) {
    if (
      !Number.isFinite(config.challengeWindowSeconds) ||
      config.challengeWindowSeconds < 0
    ) {
      throw new FinalizationValidationError(
        `challengeWindowSeconds must be a non-negative number, got: ${config.challengeWindowSeconds}`
      );
    }

    this.challengeWindowSeconds = config.challengeWindowSeconds;
    this.maxRunMs = config.maxRunMs ?? 0;
    this.clockSkewToleranceMs = config.clockSkewToleranceMs ?? 0;
    this.now = config.now ?? (() => Date.now());
  }

  async run(): Promise<FinalizationJobResult> {
    const startedAt = new Date(this.now());
    // Subtracting the tolerance as well as the window makes the cutoff
    // stricter (further in the past): a fast host clock cannot shrink the
    // effective challenge window below `challengeWindowSeconds` (#1546).
    const windowCutoff = new Date(
      this.now() - this.challengeWindowSeconds * 1000 - this.clockSkewToleranceMs
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
      const completedAt = new Date(this.now());
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
        this.now() - startedAt.getTime() >= this.maxRunMs
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
          new Date(this.now() - this.clockSkewToleranceMs)
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
        // "rejected": challenge upheld, candidate REJECTED in this transaction.
        // "inconclusive": neither upheld nor explicitly denied (tie or a
        // missing score) — candidate left CHALLENGED, revisit on a later run.
        // undefined: no CHALLENGED branch taken, or it fell through to
        // finalization (missing-competitor-denies-challenge product rule).
        const txState: { outcome?: "rejected" | "inconclusive" } = {};
        await this.prisma.$transaction(async (tx) => {
          const now = new Date(this.now());

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
          // Adjudicate challenges by comparing confidence scores as decimals
          // — never via `Number(score) : 0`, which would turn a genuinely
          // null score into a 0 and make two null scores look like a tie.
          //
          // Documented product rule: a missing competitor (no other
          // PROPOSED row for this market) means there is no evidence to
          // beat the original proposal, so the challenge is denied and this
          // candidate falls through to finalization below.
          //
          // When a competitor does exist, the challenge is only ever
          // explicitly upheld or explicitly denied when BOTH scores are
          // actual (non-null) decimals and one is strictly greater than the
          // other:
          //   - competing > challenge  -> challenge upheld, REJECT this one.
          //   - challenge > competing  -> challenge denied, finalize below.
          //   - equal scores, or either score missing -> inconclusive; this
          //     is NOT a denial, so the candidate stays CHALLENGED and is
          //     skipped this run rather than silently finalized.
          //
          // `challengeDenied` makes the "no better competitor" outcome an
          // explicit, named decision rather than something the accept path
          // below merely inherits by falling out of this `if` unchallenged
          // (#1550). The accept path asserts on this flag instead of just
          // trusting that every way of reaching it already implies denial —
          // so a future edit to the upheld-challenge branch above that adds
          // another way to fall through here (without an explicit `return`)
          // is caught by the assertion below instead of silently finalizing
          // a challenge that was never actually adjudicated.
          let challengeDenied = false;

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

            if (competing) {
              // Decimal(5,4) columns compared as Decimal, not as JavaScript
              // numbers (#1547): converting with `Number()` first can make two
              // close-but-distinct scores compare equal, or sort differently
              // from the `orderBy: confidenceScore` the query above just used.
              const challengeScore =
                candidate.confidenceScore === null ||
                candidate.confidenceScore === undefined
                  ? null
                  : new Decimal(candidate.confidenceScore.toString());
              const competingScore =
                competing.confidenceScore === null ||
                competing.confidenceScore === undefined
                  ? null
                  : new Decimal(competing.confidenceScore.toString());

              const upheld =
                challengeScore !== null &&
                competingScore !== null &&
                competingScore.greaterThan(challengeScore);

              const explicitlyDenied =
                challengeScore !== null &&
                competingScore !== null &&
                challengeScore.greaterThan(competingScore);

              if (upheld) {
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

                txState.outcome = "rejected";
                return;
              }

              if (!explicitlyDenied) {
                // Tie (equal decimal scores) or a null score on either side:
                // not an explicit denial of the challenge. Leave CHALLENGED
                // and revisit on a later run instead of guessing.
                this.logger.info(
                  "Challenged candidate left pending: scores tie or are undefined",
                  {
                    candidateId: candidate.id,
                    marketId: candidate.marketId,
                    competingCandidateId: competing.id,
                    challengeScore: challengeScore?.toString() ?? null,
                    competingScore: competingScore?.toString() ?? null,
                  }
                );

                txState.outcome = "inconclusive";
                return;
              }
            }

            // Challenge denied: no competing PROPOSED candidate with higher
            // confidence exists, so this CHALLENGED row is eligible to be
            // finalized below.
            challengeDenied = true;
          }

          // ── Finalize PROPOSED or denied-CHALLENGED candidates ───────────
          // Reachable only for a PROPOSED candidate, or a CHALLENGED one
          // whose challenge was just explicitly denied above — never merely
          // because execution fell out of the `if` block (#1550).
          if (locked.status !== "PROPOSED" && !challengeDenied) {
            throw new CandidateNotEligibleError(candidate.id, locked.status);
          }
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

        if (txState.outcome === "inconclusive") {
          // Tie or undefined score: left CHALLENGED, not finalized this run.
          results.push({
            candidateId: candidate.id,
            marketId: candidate.marketId,
            proposedOutcome: candidate.proposedOutcome,
            status: "skipped",
          });
        } else if (!txState.outcome) {
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
          // outcome === "rejected": challenge upheld, candidate REJECTED
          // (pre-existing behavior: reported as "finalized" since the job
          // reached a terminal decision for this candidate).
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

    const completedAt = new Date(this.now());
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
