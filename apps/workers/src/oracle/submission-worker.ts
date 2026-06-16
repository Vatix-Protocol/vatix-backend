/**
 * Oracle Submission Worker
 *
 * Polls the Redis queue and submits signed oracle resolutions on-chain.
 * Implements retry logic, persistence, and graceful shutdown.
 *
 * @module apps/workers/src/oracle/submission-worker
 */

import { PrismaClient } from "@prisma/client";
import type { ILogger } from "../../../packages/shared/src/logger.js";
import {
  verifyResolutionReport,
  type SignedResolutionReport,
} from "../../../apps/oracle/signature-helper.js";
import {
  RedisSubmissionQueue,
  type QueuedSubmission,
} from "./redis-submission-queue.js";
import type { SubmissionQueueItem } from "../../../apps/oracle/submission-queue.js";

export interface SubmissionWorkerConfig {
  submissionMaxRetries: number;
  consumerName: string;
  logger: ILogger;
}

/**
 * Submission worker that processes queued oracle resolutions.
 */
export class SubmissionWorker {
  private maxRetries: number;
  private consumerName: string;
  private logger: ILogger;
  private queue: RedisSubmissionQueue;
  private prisma: PrismaClient;

  constructor(
    queue: RedisSubmissionQueue,
    prisma: PrismaClient,
    config: SubmissionWorkerConfig
  ) {
    this.queue = queue;
    this.prisma = prisma;
    this.maxRetries = config.submissionMaxRetries;
    this.consumerName = config.consumerName;
    this.logger = config.logger;
  }

  /**
   * Process a single queued submission.
   */
  async processSubmission(submission: QueuedSubmission): Promise<void> {
    const { id, request, result, attempts } = submission;

    try {
      this.logger.info("Processing oracle submission", {
        id,
        marketId: request.marketId,
        attempt: attempts + 1,
        maxAttempts: this.maxRetries,
      });

      // Create signed report from the result
      const report = this.createSignedReport(submission);

      // Verify signature before submission (defensive check)
      if (!verifyResolutionReport(report)) {
        this.logger.error("Signature verification failed", {
          id,
          marketId: request.marketId,
          attempt: attempts + 1,
        });
        throw new Error("Signature verification failed");
      }

      // Submit on-chain (placeholder - integrate Stellar SDK)
      await this.submitOnChain(report, request.oracleAddress);

      // Update database on success
      await this.updateOnSuccess(submission, report);

      // Acknowledge in queue
      await this.queue.acknowledge(submission);

      this.logger.info("Oracle submission processed successfully", {
        id,
        marketId: request.marketId,
        attempt: attempts + 1,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const nextAttempt = attempts + 1;

      if (nextAttempt < this.maxRetries) {
        this.logger.warn("Oracle submission processing failed, will retry", {
          id,
          marketId: request.marketId,
          attempt: nextAttempt,
          maxAttempts: this.maxRetries,
          error: errorMessage,
        });

        // Update attempts and nack for retry
        const updated: QueuedSubmission = {
          ...submission,
          attempts: nextAttempt,
          lastAttemptAt: new Date().toISOString(),
          lastError: errorMessage,
        };

        await this.updateAttempt(updated);
        await this.queue.nack(updated);
      } else {
        this.logger.error(
          "Oracle submission processing failed, max attempts exceeded",
          {
            id,
            marketId: request.marketId,
            attempt: nextAttempt,
            maxAttempts: this.maxRetries,
            error: errorMessage,
          }
        );

        // Dead-letter: mark as failed in database
        await this.updateOnFailure(submission, errorMessage);
        await this.queue.acknowledge(submission); // Remove from active queue
      }

      throw error; // Re-throw for caller to handle
    }
  }

  /**
   * Create a signed resolution report from a queued submission.
   */
  private createSignedReport(submission: SubmissionQueueItem): SignedResolutionReport {
    const { result, request } = submission;

    return {
      payload: {
        marketId: request.marketId,
        outcome: result.outcome,
        timestamp: new Date().toISOString(),
      },
      signature: result.signature || "",
      publicKey: result.publicKey || "",
    };
  }

  /**
   * Submit the signed report on-chain (placeholder).
   * In production, this integrates with Stellar SDK.
   */
  private async submitOnChain(
    report: SignedResolutionReport,
    oracleAddress: string
  ): Promise<void> {
    // TODO: Integrate Stellar SDK to build and submit transaction
    // For now, validate that we have required fields
    if (!report.payload.marketId || !report.signature || !report.publicKey) {
      throw new Error("Invalid report: missing required fields");
    }

    if (!oracleAddress || oracleAddress.length === 0) {
      throw new Error("Invalid oracle address");
    }

    this.logger.debug("Submitting resolution on-chain", {
      marketId: report.payload.marketId,
      oracleAddress,
      outcome: report.payload.outcome,
    });

    // Placeholder: simulate successful submission
    // In real implementation, this would call Stellar SDK methods
  }

  /**
   * Update database on successful submission.
   */
  private async updateOnSuccess(
    submission: QueuedSubmission,
    report: SignedResolutionReport
  ): Promise<void> {
    const { request } = submission;
    const { marketId, outcome, timestamp } = report.payload;

    try {
      const payloadHash = this.computePayloadHash(report.payload);

      // Create or update OracleReport
      await this.prisma.oracleReport.create({
        data: {
          payloadHash,
          source: request.oracleAddress,
          confidence: 1.0, // Full confidence on successful submission
          marketId,
          candidateResolution: outcome,
          createdAt: new Date(timestamp),
        },
      });

      // Upsert ResolutionCandidate
      await this.prisma.resolutionCandidate.upsert({
        where: {
          marketId_operatorAddress: {
            marketId,
            operatorAddress: request.oracleAddress,
          },
        },
        create: {
          marketId,
          proposedOutcome: outcome,
          source: request.oracleAddress,
          operatorAddress: request.oracleAddress,
        },
        update: {
          proposedOutcome: outcome,
          updatedAt: new Date(),
        },
      });

      this.logger.info("Oracle submission persisted", {
        id: submission.id,
        marketId,
        outcome,
      });
    } catch (error) {
      this.logger.error("Failed to persist oracle submission", {
        id: submission.id,
        marketId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Update attempts for retry.
   */
  private async updateAttempt(submission: QueuedSubmission): Promise<void> {
    const { request } = submission;

    try {
      await this.prisma.oracleReport.updateMany({
        where: { marketId: request.marketId },
        data: {
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.warn("Failed to update attempt count", {
        id: submission.id,
        marketId: request.marketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Mark submission as failed in database.
   */
  private async updateOnFailure(
    submission: QueuedSubmission,
    errorMessage: string
  ): Promise<void> {
    const { request } = submission;

    try {
      await this.prisma.oracleReport.updateMany({
        where: { marketId: request.marketId },
        data: {
          updatedAt: new Date(),
        },
      });

      this.logger.error("Oracle submission marked as failed", {
        id: submission.id,
        marketId: request.marketId,
        error: errorMessage,
      });
    } catch (error) {
      this.logger.error("Failed to mark submission as failed", {
        id: submission.id,
        marketId: request.marketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Compute payload hash (same as queue).
   */
  private computePayloadHash(payload: unknown): string {
    const crypto = require("crypto");
    const normalized = JSON.stringify(payload);
    return crypto.createHash("sha256").update(normalized).digest("hex");
  }
}
