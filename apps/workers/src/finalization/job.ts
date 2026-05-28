import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { Logger } from "../../../indexer/src/logger.js";

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
    private readonly logger: Logger,
    config: FinalizationJobConfig
  ) {
    this.challengeWindowSeconds = config.challengeWindowSeconds;
  }

  async run(): Promise<void> {
    if (
      !Number.isFinite(this.challengeWindowSeconds) ||
      this.challengeWindowSeconds < 0
    ) {
      throw new FinalizationValidationError(
        `challengeWindowSeconds must be a non-negative number, got: ${this.challengeWindowSeconds}`
      );
    }

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
      return;
    }

    this.logger.info("Finalization job selected candidates", {
      count: candidates.length,
    });

    for (const candidate of candidates) {
      this.logger.info("Finalization candidate eligible", {
        candidateId: candidate.id,
        marketId: candidate.marketId,
        proposedOutcome: candidate.proposedOutcome,
        source: candidate.source,
        createdAt: candidate.createdAt.toISOString(),
      });
    }

    this.logger.info("Finalization job complete", {
      eligible: candidates.length,
    });
  }
}
