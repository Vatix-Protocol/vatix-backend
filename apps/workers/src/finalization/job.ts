import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { Logger } from "../../../indexer/src/logger.js";

export interface FinalizationCandidate {
  id: string;
  marketId: string;
  proposedOutcome: boolean;
  source: string;
  createdAt: Date;
}

export class FinalizationJob {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
    private readonly challengeWindowSeconds: number
  ) {}

  async run(): Promise<void> {
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
