import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import type {
  FinalizationJobResult,
  FinalizationCandidateResult,
} from "./types.js";

/**
 * Configuration for a single FinalizationJob run.
 * Passed to the constructor so callers never deal with raw primitives.
 */
export interface FinalizationJobConfig {
  /** How long (in seconds) a resolution candidate must sit in PROPOSED
   *  before it is eligible for finalization. Must be >= 0. */
  challengeWindowSeconds: number;
}

export interface FinalizationCandidate {
  id: string;
  marketId: string;
  proposedOutcome: boolean;
  source: string;
  createdAt: Date;
}

export class FinalizationValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "FinalizationValidationError";
  }
}

export class FinalizationJob {
  private readonly challengeWindowSeconds: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: ILogger,
    config: FinalizationJobConfig
  ) {
    this.challengeWindowSeconds = config.challengeWindowSeconds;
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
    const windowCutoff = new Date(
      Date.now() - this.challengeWindowSeconds * 1000
    );

    this.logger.info("Finalization job started", {
      challengeWindowSeconds: this.challengeWindowSeconds,
      windowCutoff: windowCutoff.toISOString(),
    });

    let candidates: FinalizationCandidate[];

    try {
      candidates = await this.prisma.resolutionCandidate.findMany({
        where: {
          status: "PROPOSED",
          createdAt: { lte: windowCutoff },
        },
        select: {
          id: true,
          marketId: true,
          proposedOutcome: true,
          source: true,
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
      this.logger.info("Finalization candidate eligible", {
        candidateId: candidate.id,
        marketId: candidate.marketId,
        proposedOutcome: candidate.proposedOutcome,
        source: candidate.source,
        createdAt: candidate.createdAt.toISOString(),
      });

      try {
        await this.prisma.$transaction(async (tx) => {
          const now = new Date();

          await tx.resolution.create({
            data: {
              marketId: candidate.marketId,
              outcome: candidate.proposedOutcome,
              finalizedAt: now,
              provenance: candidate.source,
            },
          });

          await tx.market.update({
            where: { id: candidate.marketId },
            data: {
              status: "RESOLVED",
              outcome: candidate.proposedOutcome,
              resolutionTime: now,
            },
          });

          await tx.resolutionCandidate.update({
            where: { id: candidate.id },
            data: { status: "ACCEPTED" },
          });

          await tx.userPosition.updateMany({
            where: { marketId: candidate.marketId },
            data: { isSettled: true },
          });
        });

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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

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
