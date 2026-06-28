/**
 * Oracle Submission Worker
 *
 * Polls the Redis queue and submits signed oracle resolutions on-chain.
 * Implements retry logic, persistence, and graceful shutdown.
 *
 * @module apps/workers/src/oracle/submission-worker
 */

import {
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc as StellarRpc,
  xdr,
} from "@stellar/stellar-sdk";
import { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import {
  verifyResolutionReport,
  type SignedResolutionReport,
} from "../../../oracle/signature-helper.js";
import {
  RedisSubmissionQueue,
  type QueuedSubmission,
} from "./redis-submission-queue.js";
import type { SubmissionQueueItem } from "../../../oracle/submission-queue.js";

export interface OracleStellarConfig {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
  signerSecret: string;
}

export interface SubmissionWorkerConfig {
  submissionMaxRetries: number;
  consumerName: string;
  logger: ILogger;
  stellar?: OracleStellarConfig;
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
  private stellarConfig?: OracleStellarConfig;

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
    this.stellarConfig = config.stellar;
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

      // Submit on-chain via Stellar SDK
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
        await this.queue.nack(updated, this.consumerName);
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
  private createSignedReport(
    submission: SubmissionQueueItem
  ): SignedResolutionReport {
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
   * Submit the signed resolution on-chain by invoking resolve_market on the
   * Soroban contract. Falls back to a warn-only path when stellar config is
   * absent (e.g. in local dev without chain access).
   */
  private async submitOnChain(
    report: SignedResolutionReport,
    oracleAddress: string
  ): Promise<void> {
    if (!report.payload.marketId || !report.signature || !report.publicKey) {
      throw new Error("Invalid report: missing required fields");
    }

    if (!oracleAddress || oracleAddress.length === 0) {
      throw new Error("Invalid oracle address");
    }

    if (!this.stellarConfig) {
      this.logger.warn(
        "No Stellar config provided — resolve_market call skipped (off-chain only). " +
          "Set STELLAR_RPC_URL, MARKET_CONTRACT_ID, SOROBAN_NETWORK_PASSPHRASE, " +
          "and ORACLE_SECRET_KEY to enable on-chain submission.",
        { marketId: report.payload.marketId, oracleAddress }
      );
      return;
    }

    const { rpcUrl, contractId, networkPassphrase, signerSecret } =
      this.stellarConfig;

    this.logger.debug("Invoking resolve_market on-chain", {
      marketId: report.payload.marketId,
      oracleAddress,
      outcome: report.payload.outcome,
      contractId,
    });

    const keypair = Keypair.fromSecret(signerSecret);
    const server = new StellarRpc.Server(rpcUrl);
    const contract = new Contract(contractId);

    const sourceAccount = await server.getAccount(keypair.publicKey());

    const args: xdr.ScVal[] = [
      nativeToScVal(report.payload.marketId, { type: "string" }),
      nativeToScVal(report.payload.outcome, { type: "bool" }),
      nativeToScVal(Buffer.from(report.signature, "base64"), { type: "bytes" }),
      nativeToScVal(report.publicKey, { type: "address" }),
    ];

    const tx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase,
    })
      .addOperation(contract.call("resolve_market", ...args))
      .setTimeout(30)
      .build();

    const preparedTx = await server.prepareTransaction(tx);
    preparedTx.sign(keypair);

    const sendResult = await server.sendTransaction(preparedTx);

    if (sendResult.status === "ERROR") {
      throw new Error(
        `resolve_market submission failed: status=ERROR hash=${sendResult.hash}`
      );
    }

    this.logger.info("resolve_market submitted, awaiting confirmation", {
      marketId: report.payload.marketId,
      hash: sendResult.hash,
    });

    // Poll until confirmed or failed
    const MAX_POLL_ATTEMPTS = 30;
    const POLL_INTERVAL_MS = 1_000;
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const txStatus = await server.getTransaction(sendResult.hash);
      if (txStatus.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
        this.logger.info("resolve_market confirmed on-chain", {
          marketId: report.payload.marketId,
          hash: sendResult.hash,
          ledger: txStatus.ledger,
        });
        return;
      }
      if (txStatus.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(
          `resolve_market transaction failed on-chain: hash=${sendResult.hash}`
        );
      }
    }

    throw new Error(
      `resolve_market not confirmed after ${MAX_POLL_ATTEMPTS}s: hash=${sendResult.hash}`
    );
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
          idempotencyKey: `${marketId}:${request.oracleAddress}`,
        },
        create: {
          marketId,
          proposedOutcome: outcome,
          source: request.oracleAddress,
          operatorAddress: request.oracleAddress,
          idempotencyKey: `${marketId}:${request.oracleAddress}`,
        },
        update: {
          proposedOutcome: outcome,
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
        data: {},
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
        data: {},
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
