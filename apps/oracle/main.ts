/**
 * Oracle Entrypoint
 *
 * Poll → resolve → sign → OracleReport → enqueue pipeline.
 * Reads open markets from DB, resolves each via the OracleService,
 * signs the result, and pushes a SubmissionQueueItem into Redis.
 *
 * @module apps/oracle/main
 */

import "dotenv/config";
import {
  getPrismaClient,
  disconnectPrisma,
} from "../../src/services/prisma.js";
import { redis } from "../../src/services/redis.js";
import { createLogger } from "../indexer/src/logger.js";
import { loadOracleConfig } from "./oracle-config.js";
import { OracleService } from "./oracle-service.js";
import { PrimaryAdapter } from "./primary-adapter.js";
import { FallbackAdapter } from "./fallback-adapter.js";
import { signResolutionReport } from "./signature-helper.js";
import { BullMQSubmissionQueue } from "../workers/src/oracle/bullmq-submission-queue.js";
import type { ResolutionRequest } from "./provider-adapter.js";
import type {
  ShutdownHandler,
  ShutdownSignal,
} from "../workers/src/finalization/types.js";

async function poll(queue: BullMQSubmissionQueue): Promise<void> {
  const config = loadOracleConfig();
  const logger = createLogger(config.logLevel);
  const prisma = getPrismaClient();

  if (!config.secretKey) {
    throw new Error("ORACLE_SECRET_KEY is required");
  }
  const secretKey = config.secretKey;

  const primaryBaseUrl =
    process.env.ORACLE_PRIMARY_URL ?? "http://localhost:9001";

  // Support a comma-separated list of fallback URLs for the provider chain.
  // Falls back to the single ORACLE_FALLBACK_URL for backward compatibility.
  const fallbackUrls = process.env.ORACLE_FALLBACK_URLS
    ? process.env.ORACLE_FALLBACK_URLS.split(",")
        .map((u) => u.trim())
        .filter(Boolean)
    : [process.env.ORACLE_FALLBACK_URL ?? "http://localhost:9002"];

  const oracleService = new OracleService({
    primaryAdapter: new PrimaryAdapter({ baseUrl: primaryBaseUrl }),
    fallbackAdapter: new FallbackAdapter({
      providers: fallbackUrls.map((url, i) => ({
        url,
        source: `fallback-${i + 1}`,
      })),
    }),
    logger,
    enableFallback: true,
  });

  // Fetch all ACTIVE markets that have an oracle address
  const markets = await prisma.market.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, oracleAddress: true },
  });

  for (const market of markets) {
    if (!market.oracleAddress) continue;

    const request: ResolutionRequest = {
      marketId: market.id,
      oracleAddress: market.oracleAddress,
    };

    try {
      const result = await oracleService.resolve(request);

      const report = signResolutionReport(
        {
          marketId: market.id,
          outcome: result.outcome,
          timestamp: result.timestamp,
        },
        secretKey
      );

      // Store OracleReport in DB
      await prisma.oracleReport.create({
        data: {
          payloadHash: Buffer.from(JSON.stringify(report.payload))
            .toString("hex")
            .slice(0, 64),
          source: market.oracleAddress,
          confidence: result.confidence,
          marketId: market.id,
          candidateResolution: result.outcome,
          createdAt: new Date(result.timestamp),
        },
      });

      // Enqueue for on-chain submission
      await queue.enqueue({
        id: `${market.id}-${Date.now()}`,
        request,
        result: {
          ...result,
          signature: report.signature,
          publicKey: report.publicKey,
        },
        status: "pending",
        enqueuedAt: new Date().toISOString(),
        attempts: 0,
      });

      logger.info("Market resolved and enqueued", {
        marketId: market.id,
        outcome: result.outcome,
        confidence: result.confidence,
      });
    } catch (error) {
      logger.error("Failed to resolve market", {
        marketId: market.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function bootstrap(): Promise<void> {
  const config = loadOracleConfig();
  const logger = createLogger(config.logLevel);

  logger.info("Oracle starting", { pollIntervalMs: config.pollIntervalMs });

  const queue = new BullMQSubmissionQueue(logger);

  // Run immediately, then on interval
  await poll(queue);
  const timer = setInterval(
    () =>
      void poll(queue).catch((err) => {
        logger.error("Poll cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    config.pollIntervalMs
  );

  const VALID_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let isShuttingDown = false;

  const shutdown: ShutdownHandler = async (signal: ShutdownSignal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("Oracle shutdown initiated", { signal });
    clearInterval(timer);

    try {
      await queue.close();
      await disconnectPrisma();
      await redis.disconnect();
      logger.info("Oracle shutdown complete", { signal });
      process.exit(0);
    } catch (error) {
      logger.error("Oracle shutdown failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void bootstrap().catch((error) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      message: "Oracle failed during bootstrap",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
