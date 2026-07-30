/**
 * Oracle Submission Worker Entrypoint — BullMQ (ADR 001)
 *
 * Replaces the RedisSubmissionQueue polling loop with a BullMQ Worker.
 * Retry/backoff/DLQ are now handled by BullMQ via DEFAULT_JOB_OPTIONS.
 *
 * Crash safety (#996): submissions are tracked through a durable
 * PENDING -> SUBMITTED -> CONFIRMED|FAILED state machine keyed by
 * (marketId, payloadHash) — see ./submission-reconciliation.ts. The tx hash
 * is persisted immediately after broadcast, before confirmation is polled,
 * and any submission left SUBMITTED from a prior process (crash/restart) is
 * reconciled against the chain on startup before new jobs are processed.
 *
 * @module apps/workers/src/oracle/main
 */

import "dotenv/config";
import { createLogger } from "../../../indexer/src/logger.js";
import {
  getPrismaClient,
  disconnectPrisma,
} from "../../../../src/services/prisma.js";
import { redis } from "../../../../src/services/redis.js";
import { loadOracleWorkerConfig } from "../../../../packages/shared/src/config.js";
import {
  resolveOracleStellarConfig,
  type ResolvedOracleStellarConfig,
} from "./stellar-config.js";
import {
  BullMQSubmissionQueue,
  createOracleSubmissionWorker,
} from "./bullmq-submission-queue.js";
import type { SubmissionQueueItem } from "../../../oracle/submission-queue.js";
import {
  verifyResolutionReport,
  type SignedResolutionReport,
} from "../../../oracle/signature-helper.js";
import {
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc as StellarRpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { ShutdownSignal } from "../../../../packages/shared/src/shutdown.js";
import { createShutdown } from "../../../../packages/shared/src/shutdown.js";
import { withRetry } from "../../../oracle/retry-utils.js";
import {
  checkOnChainStatus,
  claimSubmissionIntent,
  computePayloadHash,
  recordBroadcast,
  recordConfirmed,
  reconcileInFlightSubmissions,
  resetForRetry,
  type OracleReportRow,
} from "./submission-reconciliation.js";
import { oracleSubmissionAmbiguousTotal } from "../../../../src/services/metrics.js";

type OracleStellarConfig = ResolvedOracleStellarConfig;

/** Thrown when a broadcast tx's on-chain status cannot yet be determined.
 *  BullMQ will retry the job, which re-checks chain status rather than
 *  building and sending a new transaction. */
class AmbiguousSubmissionError extends Error {
  constructor(marketId: string, txHash: string) {
    super(
      `resolve_market submission is ambiguous (unconfirmed): marketId=${marketId} hash=${txHash}`
    );
    this.name = "AmbiguousSubmissionError";
  }
}

const STELLAR_RPC_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5_000,
};

/**
 * Broadcasts the signed resolution on-chain, persisting the tx hash the
 * instant it's known (before polling for confirmation), then polls until
 * confirmed or definitively failed.
 */
async function broadcastAndConfirm(
  report: SignedResolutionReport,
  payloadHash: string,
  attempts: number,
  stellar: OracleStellarConfig,
  prisma: ReturnType<typeof getPrismaClient>,
  logger: ReturnType<typeof createLogger>
): Promise<string> {
  const { rpcUrl, contractId, networkPassphrase, signerSecret } = stellar;
  const marketId = report.payload.marketId;

  logger.debug("Invoking resolve_market on-chain", {
    marketId,
    outcome: report.payload.outcome,
    contractId,
  });

  const keypair = Keypair.fromSecret(signerSecret);
  const server = new StellarRpc.Server(rpcUrl);
  const contract = new Contract(contractId);

  const onRpcRetry = (error: Error, attempt: number, delayMs: number) => {
    logger.warn("Retrying Stellar RPC call for resolve_market", {
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

  logger.info("resolve_market submitted, awaiting confirmation", {
    marketId,
    hash: sendResult.hash,
  });

  // Persist the tx hash immediately — before polling for confirmation. This
  // is the durable record a restart reconciles against if the process
  // crashes anywhere between here and observing confirmation.
  await recordBroadcast(prisma, {
    marketId,
    payloadHash,
    txHash: sendResult.hash,
    attempts,
  });

  const MAX_POLL = 30;
  for (let i = 0; i < MAX_POLL; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    const txStatus = await server.getTransaction(sendResult.hash);
    if (txStatus.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
      logger.info("resolve_market confirmed on-chain", {
        marketId,
        hash: sendResult.hash,
        ledger: txStatus.ledger,
      });
      await recordConfirmed(prisma, {
        marketId,
        payloadHash,
        txHash: sendResult.hash,
      });
      return sendResult.hash;
    }
    if (txStatus.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
      await resetForRetry(prisma, { marketId, payloadHash, attempts });
      throw new Error(
        `resolve_market transaction failed on-chain: hash=${sendResult.hash}`
      );
    }
  }

  // Timed out waiting for confirmation. The tx hash is already durably
  // persisted (recordBroadcast above), so this is ambiguous, not failed —
  // leave the row SUBMITTED and let the next attempt (or startup
  // reconciliation) re-check the chain rather than resubmitting.
  oracleSubmissionAmbiguousTotal.inc();
  throw new AmbiguousSubmissionError(marketId, sendResult.hash);
}

/**
 * Checks a previously-broadcast, unconfirmed tx against the chain instead of
 * blindly resubmitting. Only definite (timebound-expired) non-inclusion
 * clears the row for a fresh broadcast.
 */
async function reconcileBeforeResubmit(
  marketId: string,
  payloadHash: string,
  intent: OracleReportRow,
  stellar: OracleStellarConfig,
  prisma: ReturnType<typeof getPrismaClient>,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const txHash = intent.txHash!;
  const server = new StellarRpc.Server(stellar.rpcUrl);

  const result = await checkOnChainStatus(server, txHash, intent.broadcastAt);

  if (result === "CONFIRMED") {
    await recordConfirmed(prisma, { marketId, payloadHash, txHash });
    logger.info("Prior oracle submission confirmed on recheck", {
      marketId,
      txHash,
    });
    return;
  }

  if (result === "FAILED") {
    await resetForRetry(prisma, {
      marketId,
      payloadHash,
      attempts: intent.attempts,
    });
    logger.warn(
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

async function bootstrap(): Promise<void> {
  const config = loadOracleWorkerConfig();
  const logger = createLogger(config.logLevel);
  const prisma = getPrismaClient();

  const stellarConfig = resolveOracleStellarConfig(process.env);

  if (!stellarConfig) {
    logger.warn(
      "Oracle Stellar config incomplete — resolve_market calls disabled. " +
        "Set STELLAR_RPC_URL, INDEXER_CONTRACT_ID (or MARKET_CONTRACT_ID), SOROBAN_NETWORK_PASSPHRASE, " +
        "and ORACLE_SECRET_KEY to enable on-chain submission.",
      { component: "oracle-worker" }
    );
  }

  // Reconcile any submission left broadcast-but-unconfirmed by a prior
  // process (crash, deploy, OOM-kill) before accepting new work, so a
  // stale in-flight tx isn't shadowed by a fresh resubmission.
  const reconciliationServer = stellarConfig
    ? new StellarRpc.Server(stellarConfig.rpcUrl)
    : undefined;
  await reconcileInFlightSubmissions(prisma, reconciliationServer, logger);

  logger.info("Oracle submission worker starting (BullMQ)", {
    component: "oracle-worker",
  });

  const bullWorker = createOracleSubmissionWorker(
    async (item: SubmissionQueueItem, attemptsMade: number) => {
      const { request, result } = item;

      // Use the result's own timestamp (set once, at enqueue time) rather
      // than minting a fresh one per attempt — a stable payload is required
      // both for signature verification (signed with this exact timestamp)
      // and for the payload hash to stay constant across retries (#996).
      const report: SignedResolutionReport = {
        payload: {
          marketId: request.marketId,
          outcome: result.outcome,
          timestamp: result.timestamp,
        },
        signature: result.signature || "",
        publicKey: result.publicKey || "",
      };

      const payloadHash = computePayloadHash(report.payload);

      // Durable intent: claim (or fetch) the state-machine row *before* doing
      // anything else, so a redelivery that fails signature verification
      // still has a row to record the failure against.
      const intent = await claimSubmissionIntent(prisma, {
        marketId: request.marketId,
        payloadHash,
        source: request.oracleAddress,
        candidateResolution: result.outcome,
        createdAt: new Date(report.payload.timestamp),
      });

      if (intent.status === "CONFIRMED") {
        logger.info(
          "Oracle submission already confirmed, skipping resubmission",
          { marketId: request.marketId, txHash: intent.txHash }
        );
        return;
      }

      if (!verifyResolutionReport(report)) {
        throw new Error(
          `Signature verification failed for market ${request.marketId}`
        );
      }

      if (intent.status === "SUBMITTED" && intent.txHash && stellarConfig) {
        await reconcileBeforeResubmit(
          request.marketId,
          payloadHash,
          intent,
          stellarConfig,
          prisma,
          logger
        );
      } else if (stellarConfig) {
        await broadcastAndConfirm(
          report,
          payloadHash,
          attemptsMade + 1,
          stellarConfig,
          prisma,
          logger
        );
      } else {
        logger.warn(
          "No Stellar config — resolve_market call skipped (off-chain only)",
          { marketId: request.marketId, oracleAddress: request.oracleAddress }
        );
        await prisma.oracleReport.update({
          where: {
            marketId_payloadHash: {
              marketId: request.marketId,
              payloadHash,
            },
          },
          data: { status: "CONFIRMED", txHash: null, confidence: 1.0 },
        });
      }

      await prisma.resolutionCandidate.upsert({
        where: {
          idempotencyKey: `${request.marketId}:${request.oracleAddress}`,
        },
        create: {
          marketId: request.marketId,
          proposedOutcome: result.outcome,
          source: request.oracleAddress,
          operatorAddress: request.oracleAddress,
          idempotencyKey: `${request.marketId}:${request.oracleAddress}`,
        },
        update: {
          proposedOutcome: result.outcome,
        },
      });

      logger.info("Oracle submission processed", {
        marketId: request.marketId,
        component: "oracle-worker",
      });
    },
    logger
  );

  const shutdown = createShutdown(logger, {
    timeoutMs: 30_000,
    component: "oracle-worker",
    teardown: [
      async () => {
        await bullWorker.close();
      },
      async () => {
        await disconnectPrisma();
      },
      async () => {
        await redis.disconnect();
      },
    ],
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep process alive; BullMQ worker is event-driven (no polling loop needed)
  logger.info("Oracle worker ready — listening for BullMQ jobs", {
    component: "oracle-worker",
  });
}

void bootstrap().catch((error) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      message: "Oracle worker failed during bootstrap",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
