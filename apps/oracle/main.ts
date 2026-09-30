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
import { PollScheduler } from "./oracle-scheduler.js";
import { OracleService } from "./oracle-service.js";
import { PrimaryAdapter } from "./primary-adapter.js";
import { FallbackAdapter } from "./fallback-adapter.js";
import { signResolutionReport } from "./signature-helper.js";
import { BullMQSubmissionQueue } from "../workers/src/oracle/bullmq-submission-queue.js";
import {
  OracleSubmissionLock,
  type OracleSubmissionLockConfig,
} from "./submission-queue.js";
import type { ResolutionRequest } from "./provider-adapter.js";
import type {
  ShutdownHandler,
  ShutdownSignal,
} from "../workers/src/finalization/types.js";

let globalQueue: BullMQSubmissionQueue | null = null;
let globalSubmissionLock: OracleSubmissionLock | null = null;

export function getSubmissionLock(
  config?: OracleSubmissionLockConfig
): OracleSubmissionLock {
  if (!globalSubmissionLock) {
    globalSubmissionLock = new OracleSubmissionLock(config);
  }
  return globalSubmissionLock;
}

export function setSubmissionLock(lock: OracleSubmissionLock | null): void {
  globalSubmissionLock = lock;
}

/**
 * Optional per-cycle controls for {@link poll}.
 */
export interface PollOptions {
  /**
   * Caller-owned cancellation signal — in production, the bootstrap shutdown
   * signal (#1109/#1110).
   *
   * Both adapters forward it into their in-flight `fetch`, and an abort is
   * never retried and never failed over, so a `SIGTERM` cancels a hung provider
   * request instead of waiting out the configured provider timeout (or the
   * whole cycle deadline). Markets resolved before the abort are still
   * persisted and enqueued; the market that was cancelled, and every market
   * after it, is left for the next cycle.
   */
  signal?: AbortSignal;
}

export async function poll(options: PollOptions = {}): Promise<void> {
  const config = loadOracleConfig();
  const logger = createLogger(config.logLevel);
  const prisma = getPrismaClient();
  const signal = options.signal;

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
    enableFallback: process.env.NODE_ENV !== "production",
    primaryTimeoutMs: config.primaryTimeoutMs,
    fallbackTimeoutMs: config.fallbackTimeoutMs,
    dryRun: config.dryRun,
  });

  if (config.dryRun) {
    // One warning per cycle acts as a heartbeat for this money-path-off mode:
    // operators monitoring logs can always see that the oracle is not
    // submitting, and a forgotten flag is visible rather than silent (#1146).
    logger.warn(
      "Oracle dry-run mode enabled — markets are resolved and scored, but no OracleReport is written and nothing is submitted on-chain",
      {
        event: "oracle.dry_run_enabled",
        pollIntervalMs: config.pollIntervalMs,
      }
    );
  }

  if (!globalQueue) {
    globalQueue = new BullMQSubmissionQueue(logger);
  }
  const queue = globalQueue;

  // Only markets in a resolvable lifecycle state may be submitted for resolution.
  // Soft-deleted markets (deletedAt set) are excluded, matching the finalization worker.
  const markets = await prisma.market.findMany({
    where: {
      status: { in: [...RESOLVABLE_MARKET_STATUSES] },
      deletedAt: null,
    },
    select: { id: true, oracleAddress: true },
  });

  const submissionLock = getSubmissionLock({ logger });

  for (const market of markets) {
    // A caller abort means "stop working": dial no further provider and write
    // nothing else. Anything already resolved and persisted above this point
    // stands — a cancellation never rolls back work that already succeeded.
    if (signal?.aborted) {
      logger.warn("Oracle poll aborted, skipping remaining markets", {
        event: "oracle.poll_aborted",
        marketId: market.id,
      });
      break;
    }

    if (!market.oracleAddress) continue;

    // Acquire submission lock to prevent concurrent resolution & duplicate submission in HA (#1168)
    const lockToken = await submissionLock.acquireLock(market.id);
    if (!lockToken) {
      logger.info(
        "Market submission locked by another oracle instance, skipping",
        { marketId: market.id }
      );
      continue;
    }

    const request: ResolutionRequest = {
      marketId: market.id,
      oracleAddress: market.oracleAddress,
      // Present only when a caller owns a signal, so the request shape is
      // unchanged for callers (and tests) that do not cancel.
      ...(signal ? { signal } : {}),
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

      // A market may have been CANCELLED (admin cancel or expiry sweep) while
      // the provider resolution was in flight. Re-check the lifecycle state
      // immediately before persisting a report or enqueuing a submission so
      // the scheduler never emits reports for dead markets.
      const stillResolvable = await prisma.market.findMany({
        where: {
          id: market.id,
          status: { in: [...RESOLVABLE_MARKET_STATUSES] },
          deletedAt: null,
        },
        select: { id: true },
      });
      if (stillResolvable.length === 0) {
        logger.info("Market no longer resolvable, skipping", {
          marketId: market.id,
        });
        await submissionLock.releaseLock(market.id, lockToken);
        continue;
      }

      // #1146 dry-run: stop here before any money-path side effect. The
      // provider result and confidence gate have already run (OracleService
      // logs and counts the would-be submission), but we write no OracleReport
      // and enqueue no submission.
      if (config.dryRun) {
        logger.info(
          "Oracle dry-run: skipping report persistence and submission",
          {
            event: "oracle.dry_run_skip_submission",
            marketId: market.id,
            outcome: result.outcome,
            confidence: result.confidence,
            source: result.source,
          }
        );
        await submissionLock.releaseLock(market.id, lockToken);
        continue;
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
      // A cancellation is a decision, not a fault: report it as such (an
      // `error` line for a deliberate shutdown would page someone) and stop
      // the batch instead of walking the remaining markets to re-discover that
      // the caller has already aborted.
      if (signal?.aborted) {
        logger.warn("Oracle poll aborted while resolving market", {
          event: "oracle.poll_aborted",
          marketId: market.id,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }

      logger.error("Failed to resolve market", {
        marketId: market.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Release lock on failure so the next cycle or another instance can retry
      await submissionLock.releaseLock(market.id, lockToken);
    }
  }
}

/**
 * Wraps a poll function so overlapping invocations are skipped instead of
 * running concurrently.
 *
 * Retained for callers that drive `poll()` from their own loop; the built-in
 * bootstrap uses {@link PollScheduler}, which applies the same guard plus a
 * per-cycle deadline and failure back-off (#1110). Errors from `pollFn` are
 * caught and logged, never thrown, so a single bad cycle can't take down the
 * caller.
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

  logger.info("Oracle starting", {
    pollIntervalMs: config.pollIntervalMs,
    cycleTimeoutMs: config.cycleTimeoutMs,
  });

  // #1109/#1110: one controller for the process lifetime. Aborting it on
  // shutdown cancels in-flight provider requests, so an operator's `SIGTERM`
  // drains in milliseconds instead of waiting out a hung provider — up to the
  // configured provider timeout, or the whole cycle deadline. Nothing already
  // written is rolled back: a market whose resolution already returned still
  // persists its report and enqueues, and a market whose fetch was cancelled
  // writes nothing and is resolved by the next poll cycle.
  const shutdownController = new AbortController();

  // #1110: the scheduler owns overlap protection, the per-cycle deadline, and
  // bounded back-off after consecutive failures. `poll` itself only knows how
  // to resolve one batch of markets.
  const scheduler = new PollScheduler({
    intervalMs: config.pollIntervalMs,
    cycleTimeoutMs: config.cycleTimeoutMs,
    runCycle: () => poll({ signal: shutdownController.signal }),
    logger,
  });

  const VALID_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let isShuttingDown = false;

  const shutdown: ShutdownHandler = async (signal: ShutdownSignal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("Oracle shutdown initiated", { signal });
    // Stop scheduling first, then cancel in-flight provider requests and let
    // the current cycle unwind: a resolution already fetched still persists
    // (nothing is cut off mid-write), while a hung provider is cancelled
    // instead of holding the process for the rest of the cycle deadline.
    scheduler.stop();
    shutdownController.abort(new Error(`Oracle shutdown (${signal})`));
    await scheduler.waitForIdle();

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

  scheduler.start();
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
