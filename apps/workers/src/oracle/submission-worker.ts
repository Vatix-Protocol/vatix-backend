/**
 * Oracle Submission Worker
 *
 * Polls the Redis queue and submits signed oracle resolutions on-chain.
 * Implements retry logic, crash-safe persistence, and graceful shutdown.
 *
 * Crash safety (#996): every submission is tracked through a durable
 * PENDING -> SUBMITTED -> CONFIRMED|FAILED state machine keyed by
 * (marketId, payloadHash) — see ./submission-reconciliation.ts. The tx hash
 * is persisted immediately after broadcast, *before* confirmation is
 * polled, so a crash in that window leaves a durable record a restart can
 * reconcile against the chain instead of blindly resubmitting.
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
import {
  logDeadLetter,
  type DeadLetterMessage,
} from "../consumers/dead-letter.js";
import { withRetry } from "../../../oracle/retry-utils.js";
import { assertPassphraseMatchesDeployment } from "./stellar-config.js";
import {
  checkOnChainStatus,
  claimSubmissionIntent,
  computePayloadHash,
  recordBroadcast,
  recordConfirmed,
  recordFailed,
  resetForRetry,
  type OracleReportRow,
} from "./submission-reconciliation.js";
import { oracleSubmissionAmbiguousTotal } from "../../../../src/services/metrics.js";

/** Retry config for individual Stellar RPC calls (getAccount, prepareTransaction,
 *  sendTransaction). Bounded and short-lived so a transient RPC blip is absorbed
 *  in place instead of burning one of the submission's limited job-level retries. */
const STELLAR_RPC_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5_000,
};

/** Thrown when a broadcast tx's on-chain status cannot yet be determined.
 *  Never triggers a resubmission — only the normal queue retry/backoff, which
 *  re-checks chain status (cheap) rather than sending a new transaction. */
class AmbiguousSubmissionError extends Error {
  constructor(marketId: string, txHash: string) {
    super(
      `resolve_market submission is ambiguous (unconfirmed): marketId=${marketId} hash=${txHash}`
    );
    this.name = "AmbiguousSubmissionError";
  }
}

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
  /**
   * Deployment network id (e.g. "testnet" | "mainnet"), used to verify that
   * `stellar.networkPassphrase` matches this deployment. Defaults to the
   * STELLAR_NETWORK env var, then "testnet".
   */
  stellarNetwork?: string;
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

    if (this.stellarConfig) {
      assertPassphraseMatchesDeployment(
        this.stellarConfig.networkPassphrase,
        config.stellarNetwork ?? process.env.STELLAR_NETWORK ?? "testnet"
      );
    }
  }

  /**
   * Process a single queued submission.
   */
  async processSubmission(submission: QueuedSubmission): Promise<void> {
    const { id, request, attempts } = submission;
    const report = this.createSignedReport(submission);
    const payloadHash = computePayloadHash(report.payload);
    const key = { marketId: request.marketId, payloadHash };

    try {
      this.logger.info("Processing oracle submission", {
        id,
        marketId: request.marketId,
        attempt: attempts + 1,
        maxAttempts: this.maxRetries,
      });

      // Durable intent: claim (or fetch) the state-machine row for this
      // exact (marketId, payloadHash) *before* doing anything else, so every
      // retry/redelivery of the same logical submission — including ones
      // that fail signature verification — converges on one row instead of
      // the failure path finding no row to update.
      const intent = await claimSubmissionIntent(this.prisma, {
        marketId: request.marketId,
        payloadHash,
        source: request.oracleAddress,
        candidateResolution: report.payload.outcome,
        createdAt: new Date(report.payload.timestamp),
      });

      if (intent.status === "CONFIRMED") {
        // Already confirmed by a prior attempt (e.g. broadcast succeeded,
        // then the worker crashed before acking the queue message). Do not
        // touch the chain again — just acknowledge and move on.
        this.logger.info(
          "Oracle submission already confirmed, skipping resubmission",
          { id, marketId: request.marketId, txHash: intent.txHash }
        );
        await this.queue.acknowledge(submission);
        return;
      }

      if (!verifyResolutionReport(report)) {
        this.logger.error("Signature verification failed", {
          id,
          marketId: request.marketId,
          attempt: attempts + 1,
        });
        throw new Error("Signature verification failed");
      }

      if (
        intent.status === "SUBMITTED" &&
        intent.txHash &&
        this.stellarConfig
      ) {
        // A previous attempt broadcast a tx we never confirmed (crash, or a
        // slow/timed-out poll). Check the chain before doing anything else —
        // resubmitting here would risk a double resolve_market call.
        await this.reconcileBeforeResubmit(
          request.marketId,
          payloadHash,
          intent
        );
      } else {
        await this.broadcastAndConfirm(
          report,
          request.oracleAddress,
          payloadHash,
          attempts + 1
        );
      }

      await this.updateOnSuccess(submission, report, payloadHash);
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

        const updated: QueuedSubmission = {
          ...submission,
          attempts: nextAttempt,
          lastAttemptAt: new Date().toISOString(),
          lastError: errorMessage,
        };

        await this.updateAttempt(key, nextAttempt);
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

        await this.updateOnFailure(
          { ...submission, attempts: nextAttempt },
          key,
          errorMessage
        );
        await this.queue.acknowledge(submission); // Remove from active queue
      }

      throw error; // Re-throw for caller to handle
    }
  }

  /**
   * Checks a previously-broadcast, unconfirmed tx against the chain instead
   * of blindly resubmitting. Only a definite (timebound-expired) non-
   * inclusion clears the row for a fresh broadcast; anything else is left
   * ambiguous and surfaced via metrics for reconciliation.
   */
  private async reconcileBeforeResubmit(
    marketId: string,
    payloadHash: string,
    intent: OracleReportRow
  ): Promise<string> {
    const txHash = intent.txHash!;
    const server = new StellarRpc.Server(this.stellarConfig!.rpcUrl);

    const result = await checkOnChainStatus(server, txHash, intent.broadcastAt);

    if (result === "CONFIRMED") {
      await recordConfirmed(this.prisma, { marketId, payloadHash, txHash });
      this.logger.info("Prior oracle submission confirmed on recheck", {
        marketId,
        txHash,
      });
      return txHash;
    }

    if (result === "FAILED") {
      await resetForRetry(this.prisma, {
        marketId,
        payloadHash,
        attempts: intent.attempts,
      });
      this.logger.warn(
        "Prior oracle submission definitely not included, resubmitting",
        { marketId, txHash }
      );
      throw new Error(
        `previous resolve_market tx ${txHash} not included, cleared for resubmission`
      );
    }

    oracleSubmissionAmbiguousTotal.inc();
    throw new AmbiguousSubmissionError(marketId, txHash);
  }

  /**
   * Create a signed resolution report from a queued submission. Uses the
   * result's own timestamp (set once, at enqueue time) rather than minting a
   * fresh one per attempt — a stable payload is required both for signature
   * verification (the payload was signed with this exact timestamp) and for
   * the payload hash to stay constant across retries/redeliveries (#996).
   */
  private createSignedReport(
    submission: SubmissionQueueItem
  ): SignedResolutionReport {
    const { result, request } = submission;

    return {
      payload: {
        marketId: request.marketId,
        outcome: result.outcome,
        timestamp: result.timestamp,
      },
      signature: result.signature || "",
      publicKey: result.publicKey || "",
    };
  }

  /**
   * Broadcasts the signed resolution by invoking resolve_market on the
   * Soroban contract, persists the tx hash the instant it's known, then
   * polls for confirmation.
   */
  private async broadcastAndConfirm(
    report: SignedResolutionReport,
    oracleAddress: string,
    payloadHash: string,
    attempts: number
  ): Promise<string | undefined> {
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
      return undefined;
    }

    const { rpcUrl, contractId, networkPassphrase, signerSecret } =
      this.stellarConfig;
    const marketId = report.payload.marketId;

    this.logger.debug("Invoking resolve_market on-chain", {
      marketId,
      oracleAddress,
      outcome: report.payload.outcome,
      contractId,
    });

    const keypair = Keypair.fromSecret(signerSecret);
    const server = new StellarRpc.Server(rpcUrl);
    const contract = new Contract(contractId);

    const onRpcRetry = (error: Error, attempt: number, delayMs: number) => {
      this.logger.warn("Retrying Stellar RPC call for resolve_market", {
        marketId,
        attempt,
        delayMs,
        error: error.message,
      });
    };

    const sourceAccount = await withRetry(
      () => server.getAccount(keypair.publicKey()),
      STELLAR_RPC_RETRY_CONFIG,
      onRpcRetry
    );

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

    const preparedTx = await withRetry(
      () => server.prepareTransaction(tx),
      STELLAR_RPC_RETRY_CONFIG,
      onRpcRetry
    );
    preparedTx.sign(keypair);

    const sendResult = await withRetry(
      () => server.sendTransaction(preparedTx),
      STELLAR_RPC_RETRY_CONFIG,
      onRpcRetry
    );

    if (sendResult.status === "ERROR") {
      throw new Error(
        `resolve_market submission failed: status=ERROR hash=${sendResult.hash}`
      );
    }

    this.logger.info("resolve_market submitted, awaiting confirmation", {
      marketId,
      hash: sendResult.hash,
    });

    // Persist the tx hash immediately — before polling for confirmation.
    // This is the durable record a restart reconciles against if the
    // process crashes anywhere between here and observing confirmation.
    await recordBroadcast(this.prisma, {
      marketId,
      payloadHash,
      txHash: sendResult.hash,
      attempts,
    });

    // Poll until confirmed or failed
    const MAX_POLL_ATTEMPTS = 30;
    const POLL_INTERVAL_MS = 1_000;
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const txStatus = await server.getTransaction(sendResult.hash);
      if (txStatus.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
        this.logger.info("resolve_market confirmed on-chain", {
          marketId,
          hash: sendResult.hash,
          ledger: txStatus.ledger,
        });
        await recordConfirmed(this.prisma, {
          marketId,
          payloadHash,
          txHash: sendResult.hash,
        });
        return sendResult.hash;
      }
      if (txStatus.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
        await resetForRetry(this.prisma, {
          marketId,
          payloadHash,
          attempts,
        });
        throw new Error(
          `resolve_market transaction failed on-chain: hash=${sendResult.hash}`
        );
      }
    }

    // Timed out waiting for confirmation. The tx hash is already durably
    // persisted (recordBroadcast above), so this is ambiguous, not failed —
    // leave the row as SUBMITTED and let the next attempt (or startup
    // reconciliation) re-check the chain rather than resubmitting.
    oracleSubmissionAmbiguousTotal.inc();
    throw new AmbiguousSubmissionError(marketId, sendResult.hash);
  }

  /**
   * Update database on successful submission (or the CONFIRMED state was
   * already recorded by broadcastAndConfirm — this only upserts the
   * ResolutionCandidate, which isn't part of the submission state machine).
   */
  private async updateOnSuccess(
    submission: QueuedSubmission,
    report: SignedResolutionReport,
    payloadHash: string
  ): Promise<void> {
    const { request } = submission;
    const { marketId, outcome } = report.payload;

    try {
      if (!this.stellarConfig) {
        // Off-chain fallback path: no chain to confirm against, so the
        // state machine has no SUBMITTED phase to pass through — mark
        // confirmed directly, mirroring the previous behavior.
        await this.prisma.oracleReport.update({
          where: { marketId_payloadHash: { marketId, payloadHash } },
          data: { status: "CONFIRMED", txHash: null, confidence: 1.0 },
        });
      }

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
   * Bumps the attempt count (and confidence) for a retry without disturbing
   * status/txHash — an in-flight SUBMITTED row must stay intact so the next
   * attempt reconciles against the same tx instead of losing track of it.
   */
  private async updateAttempt(
    key: { marketId: string; payloadHash: string },
    attempts: number
  ): Promise<void> {
    try {
      await this.prisma.oracleReport.update({
        where: {
          marketId_payloadHash: {
            marketId: key.marketId,
            payloadHash: key.payloadHash,
          },
        },
        data: {
          confidence: Math.max(0, 1.0 - attempts * 0.2),
          attempts,
        },
      });
    } catch (error) {
      this.logger.warn("Failed to update attempt count", {
        marketId: key.marketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Mark submission as failed in database and emit a dead-letter log entry.
   *
   * Called when max retries are exhausted. Persists the failure state to the
   * database and records a structured dead-letter log entry so that operators
   * can detect and diagnose permanently-failed submissions.
   */
  private async updateOnFailure(
    submission: QueuedSubmission,
    key: { marketId: string; payloadHash: string },
    errorMessage: string
  ): Promise<void> {
    const { request } = submission;

    // Emit dead-letter log entry so the failure is surfaced for operational
    // visibility (monitored via log aggregation / alerting pipelines).
    const deadLetterMessage: DeadLetterMessage = {
      id: submission.id,
      queue: "oracle-submission",
      payload: {
        marketId: request.marketId,
        oracleAddress: request.oracleAddress,
        attempts: submission.attempts,
      },
      reason: errorMessage,
    };
    logDeadLetter(this.logger, deadLetterMessage);

    try {
      await recordFailed(this.prisma, {
        ...key,
        attempts: submission.attempts,
      });

      await this.prisma.resolutionCandidate.updateMany({
        where: {
          marketId: request.marketId,
          source: request.oracleAddress,
        },
        data: { status: "REJECTED" },
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
}
