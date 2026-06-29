/**
 * Oracle Submission Worker Entrypoint — BullMQ (ADR 001)
 *
 * Replaces the RedisSubmissionQueue polling loop with a BullMQ Worker.
 * Retry/backoff/DLQ are now handled by BullMQ via DEFAULT_JOB_OPTIONS.
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
import { createHash } from "crypto";
import type { ShutdownHandler, ShutdownSignal } from "../finalization/types.js";

interface OracleStellarConfig {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
  signerSecret: string;
}

async function submitOnChain(
  report: SignedResolutionReport,
  oracleAddress: string,
  stellar: OracleStellarConfig,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const { rpcUrl, contractId, networkPassphrase, signerSecret } = stellar;

  logger.debug("Invoking resolve_market on-chain", {
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

  logger.info("resolve_market submitted, awaiting confirmation", {
    marketId: report.payload.marketId,
    hash: sendResult.hash,
  });

  const MAX_POLL = 30;
  for (let i = 0; i < MAX_POLL; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    const txStatus = await server.getTransaction(sendResult.hash);
    if (txStatus.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
      logger.info("resolve_market confirmed on-chain", {
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
    `resolve_market not confirmed after ${MAX_POLL}s: hash=${sendResult.hash}`
  );
}

async function bootstrap(): Promise<void> {
  const config = loadOracleWorkerConfig();
  const logger = createLogger(config.logLevel);
  const prisma = getPrismaClient();

  const stellarConfig: OracleStellarConfig | undefined = (() => {
    const rpcUrl = process.env.STELLAR_RPC_URL;
    const contractId =
      process.env.MARKET_CONTRACT_ID ?? process.env.INDEXER_CONTRACT_ID;
    const networkPassphrase = process.env.SOROBAN_NETWORK_PASSPHRASE;
    const signerSecret = process.env.ORACLE_SECRET_KEY;
    return rpcUrl && contractId && networkPassphrase && signerSecret
      ? { rpcUrl, contractId, networkPassphrase, signerSecret }
      : undefined;
  })();

  if (!stellarConfig) {
    logger.warn(
      "Oracle Stellar config incomplete — resolve_market calls disabled. " +
        "Set STELLAR_RPC_URL, MARKET_CONTRACT_ID, SOROBAN_NETWORK_PASSPHRASE, " +
        "and ORACLE_SECRET_KEY to enable on-chain submission.",
      { component: "oracle-worker" }
    );
  }

  logger.info("Oracle submission worker starting (BullMQ)", {
    component: "oracle-worker",
  });

  const bullWorker = createOracleSubmissionWorker(
    async (item: SubmissionQueueItem) => {
      const { request, result } = item;

      const report: SignedResolutionReport = {
        payload: {
          marketId: request.marketId,
          outcome: result.outcome,
          timestamp: new Date().toISOString(),
        },
        signature: result.signature || "",
        publicKey: result.publicKey || "",
      };

      if (!verifyResolutionReport(report)) {
        throw new Error(
          `Signature verification failed for market ${request.marketId}`
        );
      }

      if (stellarConfig) {
        await submitOnChain(
          report,
          request.oracleAddress,
          stellarConfig,
          logger
        );
      } else {
        logger.warn(
          "No Stellar config — resolve_market call skipped (off-chain only)",
          { marketId: request.marketId, oracleAddress: request.oracleAddress }
        );
      }

      const payloadHash = createHash("sha256")
        .update(JSON.stringify(report.payload))
        .digest("hex");

      await prisma.oracleReport.create({
        data: {
          payloadHash,
          source: request.oracleAddress,
          confidence: 1.0,
          marketId: request.marketId,
          candidateResolution: result.outcome,
          createdAt: new Date(report.payload.timestamp),
        },
      });

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

  const VALID_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const SHUTDOWN_TIMEOUT_MS = 30_000;

  let isShuttingDown = false;
  const shutdown: ShutdownHandler = async (signal: ShutdownSignal) => {
    if (
      typeof signal !== "string" ||
      signal.trim() === "" ||
      !VALID_SHUTDOWN_SIGNALS.includes(
        signal as (typeof VALID_SHUTDOWN_SIGNALS)[number]
      )
    ) {
      logger.warn("Graceful shutdown called with invalid signal", {
        signal,
        statusCode: 400,
        component: "oracle-worker",
        validSignals: [...VALID_SHUTDOWN_SIGNALS],
      });
      return;
    }

    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("Oracle worker shutdown initiated", {
      signal,
      component: "oracle-worker",
      status: "initiated",
    });

    const timeoutHandle = setTimeout(() => {
      logger.error("Shutdown timeout exceeded, forcing exit", {
        signal,
        component: "oracle-worker",
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      await bullWorker.close();
      await disconnectPrisma();
      await redis.disconnect();
      clearTimeout(timeoutHandle);

      logger.info("Oracle worker shutdown complete", {
        signal,
        component: "oracle-worker",
        status: "complete",
        exitCode: 0,
      });
      process.exit(0);
    } catch (error) {
      clearTimeout(timeoutHandle);
      logger.error("Oracle worker shutdown failed", {
        signal,
        component: "oracle-worker",
        status: "failed",
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

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
