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
import { fileURLToPath } from "url";
import {
  getPrismaClient,
  disconnectPrisma,
} from "../../src/services/prisma.js";
import { redis } from "../../src/services/redis.js";
import { RESOLVABLE_MARKET_STATUSES } from "../../packages/shared/src/marketLifecycle.js";
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

let globalQueue: BullMQSubmissionQueue | null = null;

export async function poll(): Promise<void> {
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

  if (!globalQueue) {
    globalQueue = new BullMQSubmissionQueue(logger);
  }
  const queue = globalQueue;

  // Only markets in a resolvable lifecycle state may be submitted for resolution.
  const markets = await prisma.market.findMany({
    where: { status: { in: [...RESOLVABLE_MARKET_STATUSES] } },
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

      if (
        typeof result.confidence !== "number" ||
        !Number.isFinite(result.confidence) ||
        result.confidence < 0 ||
        result.confidence > 1
      ) {
        throw new Error(
          `Resolved confidence ${result.confidence} is out of range [0, 1]`
        );
      }

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

/**
 * Wraps a poll function so overlapping invocations are skipped instead of
 * running concurrently. If a cycle takes longer than the scheduling interval
 * (e.g. a slow provider or many active markets), the next tick logs a
 * warning and returns immediately rather than double-processing the same
 * markets (duplicate provider calls, duplicate OracleReport writes).
 * Errors from `pollFn` are caught and logged, never thrown, so a single bad
 * cycle can't take down the setInterval loop.
 */
export function createOverlapGuardedPoll(
  pollFn: () => Promise<void>,
  logger: ReturnType<typeof createLogger>
): () => Promise<void> {
  let isPollInProgress = false;

  return async (): Promise<void> => {
    if (isPollInProgress) {
      logger.warn("Skipping oracle poll because a previous poll is active");
      return;
    }
    isPollInProgress = true;
    try {
      await pollFn();
    } catch (err) {
      logger.error("Poll cycle failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      isPollInProgress = false;
    }
  };
}

export async function bootstrap(): Promise<void> {
  const config = loadOracleConfig();
  const logger = createLogger(config.logLevel);

  logger.info("Oracle starting", { pollIntervalMs: config.pollIntervalMs });

  const runPoll = createOverlapGuardedPoll(poll, logger);

  // Run immediately (unguarded — fail fast on startup misconfiguration,
  // matching the previous behavior), then on interval with overlap guarding.
  await poll();
  const timer = setInterval(() => void runPoll(), config.pollIntervalMs);

  const VALID_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let isShuttingDown = false;

  const shutdown: ShutdownHandler = async (signal: ShutdownSignal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("Oracle shutdown initiated", { signal });
    clearInterval(timer);

    try {
      if (globalQueue) {
        await globalQueue.close();
      }
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

// Only auto-boot when this file is executed directly (e.g. via `tsx
// apps/oracle/main.ts`) — importing it for tests must not start the
// poll loop or touch process-level signal handlers.
const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
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
}
