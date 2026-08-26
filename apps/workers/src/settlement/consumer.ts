/**
 * Settlement Worker Entrypoint — BullMQ (ADR 001)
 *
 * Replaces the raw Redis Streams polling loop with a BullMQ Worker that
 * provides unified retry/backoff/DLQ via DEFAULT_JOB_OPTIONS.
 *
 * The SettlementWorker.process() handler is unchanged — BullMQ job data is
 * mapped to the existing QueueJob shape so all unit tests continue to pass.
 *
 * @module apps/workers/src/settlement/consumer
 */
import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { redis } from "../../../../src/services/redis.js";
import { createLogger } from "../../../indexer/src/logger.js";
import {
  getPrismaClient,
  disconnectPrisma,
} from "../../../../src/services/prisma.js";
import {
  SettlementWorker,
  type SettlementStellarConfig,
  type SettlementPrismaClient,
} from "./settlement-worker.js";
import type { QueueJob } from "../consumers/queue-consumer.js";
import {
  redisConnectionFromEnv,
  settlementQueueName,
} from "../shared/queue-config.js";
import { createShutdown } from "../../../../packages/shared/src/shutdown.js";
import { loadStellarEndpoints } from "../../../../packages/shared/src/stellarTransport.js";
import {
  startOutboxPublisher,
  stopOutboxPublisher,
} from "../../../../src/services/outbox-publisher.js";

/** Thrown when production startup is attempted with incomplete settlement Stellar config. */
class IncompleteProductionSettlementConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Production startup requires complete Stellar configuration for settlement. Missing: ${missing.join(", ")}. ` +
        `Set STELLAR_RPC_URL (or STELLAR_RPC_URLS), SETTLEMENT_CONTRACT_ID, ` +
        `SOROBAN_NETWORK_PASSPHRASE, and STELLAR_SECRET_KEY to proceed.`
    );
    this.name = "IncompleteProductionSettlementConfigError";
  }
}

/**
 * Validates settlement Stellar config in production, throwing when any required
 * variables are missing. In dev/test, returns undefined for incomplete config
 * (allowing lenient startup).
 */
function validateSettlementStellarConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string = process.env.NODE_ENV ?? "development"
): SettlementStellarConfig | undefined {
  const contractId = env.SETTLEMENT_CONTRACT_ID;
  const networkPassphrase = env.SOROBAN_NETWORK_PASSPHRASE;
  const signerSecret = env.STELLAR_SECRET_KEY;

  const hasExplicitRpc =
    Boolean(env.STELLAR_RPC_URL?.trim()) ||
    Boolean(env.STELLAR_RPC_URLS?.trim());

  const { rpcUrls } = loadStellarEndpoints(env, networkPassphrase);
  const rpcUrl = rpcUrls[0];

  // In dev/test, allow incomplete config
  if (nodeEnv !== "production") {
    return rpcUrl && contractId && networkPassphrase && signerSecret
      ? { rpcUrl, rpcUrls, contractId, networkPassphrase, signerSecret }
      : undefined;
  }

  // Production: fail fast
  const missing: string[] = [];
  if (!hasExplicitRpc) {
    missing.push("STELLAR_RPC_URL or STELLAR_RPC_URLS");
  }
  if (!contractId) {
    missing.push("SETTLEMENT_CONTRACT_ID");
  }
  if (!networkPassphrase) {
    missing.push("SOROBAN_NETWORK_PASSPHRASE");
  }
  if (!signerSecret) {
    missing.push("STELLAR_SECRET_KEY");
  }

  if (missing.length > 0) {
    throw new IncompleteProductionSettlementConfigError(missing);
  }

  return {
    rpcUrl,
    rpcUrls,
    contractId,
    networkPassphrase,
    signerSecret,
  };
}

const MAX_ATTEMPTS = 3;
const PROCESSING_TIMEOUT_MS = 30_000;
const IDEMPOTENCY_TTL_SECONDS = 86_400;
/** Permanent failures for the same tradeId before it is quarantined (#870). */
const QUARANTINE_THRESHOLD = (() => {
  const parsed = Number(process.env.SETTLEMENT_QUARANTINE_THRESHOLD);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
})();

async function bootstrap(): Promise<void> {
  const logLevel = (process.env.LOG_LEVEL ?? "info") as Parameters<
    typeof createLogger
  >[0];
  const logger = createLogger(logLevel);
  const queueName = settlementQueueName();

  logger.info("Settlement worker started (BullMQ)", {
    queue: queueName,
  });

  // Recovery path for the transactional outbox (#outbox): drains any
  // SettlementOutboxEvent rows left PENDING/FAILED after a crash or Redis
  // outage between MatchingService's DB commit and its fast-path enqueue.
  startOutboxPublisher();

  const stellar = validateSettlementStellarConfig(
    process.env,
    process.env.NODE_ENV ?? "development"
  );

  if (!stellar) {
    logger.warn(
      "Stellar config incomplete — on-chain settlement disabled. " +
        "Set STELLAR_RPC_URL (or STELLAR_RPC_URLS), SETTLEMENT_CONTRACT_ID, SOROBAN_NETWORK_PASSPHRASE, " +
        "and STELLAR_SECRET_KEY to enable.",
      { component: "settlement-worker" }
    );
  }

  const settlementWorker = new SettlementWorker(
    redis,
    logger,
    {
      maxAttempts: MAX_ATTEMPTS,
      processingTimeoutMs: PROCESSING_TIMEOUT_MS,
      idempotencyTtlSeconds: IDEMPOTENCY_TTL_SECONDS,
      stellar,
      quarantineThreshold: QUARANTINE_THRESHOLD,
    },
    getPrismaClient() as unknown as SettlementPrismaClient
  );

  const worker = new Worker<Record<string, unknown>>(
    queueName,
    async (job: Job<Record<string, unknown>>) => {
      const queueJob: QueueJob = {
        id: job.id ?? job.name,
        payload: job.data,
        attempts: job.attemptsMade + 1,
      };
      await settlementWorker.process(queueJob);
    },
    {
      connection: redisConnectionFromEnv(),
      concurrency: 1,
    }
  );

  worker.on("completed", (job) => {
    logger.info("Settlement job completed", {
      jobId: job.id,
      component: "settlement-worker",
    });
  });

  worker.on("failed", (job, err) => {
    logger.error("Settlement job failed", {
      jobId: job?.id,
      attempts: job?.attemptsMade,
      error: err.message,
      component: "settlement-worker",
    });
  });

  // BullMQ forwards Redis connection errors as "error" events. Without a
  // listener, Node's default EventEmitter behavior is to throw and crash
  // the process on the next transient Redis blip.
  worker.on("error", (err) => {
    logger.error("Settlement worker connection error", {
      error: err.message,
      component: "settlement-worker",
    });
  });

  const shutdown = createShutdown(logger, {
    timeoutMs: 30_000,
    component: "settlement-worker",
    teardown: [
      async () => {
        stopOutboxPublisher();
      },
      async () => {
        await worker.close();
      },
      async () => {
        await disconnectPrisma();
      },
      async () => {
        await redis.disconnect();
      },
    ],
  });

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => void shutdown(sig));
  }
}

void bootstrap().catch((error) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      message: "Settlement worker failed during bootstrap",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
