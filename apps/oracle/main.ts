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
import { loadOracleConfig, describeOracleConfig } from "./oracle-config.js";
import { startHealthServer } from "./health-server.js";
import { OracleService } from "./oracle-service.js";
import { PrimaryAdapter } from "./primary-adapter.js";
import { FallbackAdapter } from "./fallback-adapter.js";
import { signResolutionReport } from "./signature-helper.js";
import { BullMQSubmissionQueue } from "../workers/src/oracle/bullmq-submission-queue.js";
import { buildSubmissionIdempotencyKey } from "./submission-queue.js";
import type { ResolutionRequest } from "./provider-adapter.js";
import { createShutdown } from "../../packages/shared/src/shutdown.js";

/**
 * Hard ceiling on the graceful-shutdown sequence. Exceeding it forces
 * `process.exit(1)` so a hung provider call or stuck queue can never wedge the
 * process until the orchestrator SIGKILLs it.
 */
export const ORACLE_SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Stable error codes surfaced by the oracle entrypoint. These are part of the
 * public contract asserted by `apps/oracle/main.test.ts` so operators and
 * callers can branch on a machine-readable code instead of parsing messages.
 */
export const ORACLE_ERROR_CODES = {
  MISSING_SECRET_KEY: "ORACLE_MISSING_SECRET_KEY",
  INVALID_CONFIDENCE: "ORACLE_INVALID_CONFIDENCE",
  MARKET_NOT_RESOLVABLE: "ORACLE_MARKET_NOT_RESOLVABLE",
  DEPENDENCY_UNAVAILABLE: "ORACLE_DEPENDENCY_UNAVAILABLE",
  RESOLUTION_FAILED: "ORACLE_RESOLUTION_FAILED",
} as const;

export type OracleErrorCode =
  (typeof ORACLE_ERROR_CODES)[keyof typeof ORACLE_ERROR_CODES];

/**
 * Typed error carrying a stable `code` so fail-closed paths are testable and
 * observable without leaking secrets or provider internals.
 */
export class OracleError extends Error {
  readonly code: OracleErrorCode;
  readonly marketId?: string;

  constructor(code: OracleErrorCode, message: string, marketId?: string) {
    super(message);
    this.name = "OracleError";
    this.code = code;
    this.marketId = marketId;
  }
}

/**
 * Classifies a thrown dependency error (RPC/DB/Redis) so writes fail closed.
 * Returns true when the failure is an infrastructure outage rather than a
 * deterministic resolution error.
 */
export function isDependencyOutage(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    // Prisma connection/availability codes and generic network codes.
    if (
      code === "P1001" ||
      code === "P1002" ||
      code === "P1008" ||
      code === "P1017" ||
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND"
    ) {
      return true;
    }
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string") {
    return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|connection (refused|closed)|redis/i.test(
      message
    );
  }
  return false;
}

/**
 * Validates a resolved confidence value. Throws a typed OracleError so the
 * caller can fail closed instead of persisting an out-of-range report.
 */
export function assertValidConfidence(
  confidence: unknown,
  marketId: string
): asserts confidence is number {
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new OracleError(
      ORACLE_ERROR_CODES.INVALID_CONFIDENCE,
      `Resolved confidence ${String(confidence)} is out of range [0, 1]`,
      marketId
    );
  }
}

let globalQueue: BullMQSubmissionQueue | null = null;

export async function poll(): Promise<void> {
  const config = loadOracleConfig();
  const logger = createLogger(config.logLevel);
  const prisma = getPrismaClient();

  if (!config.secretKey) {
    throw new OracleError(
      ORACLE_ERROR_CODES.MISSING_SECRET_KEY,
      "ORACLE_SECRET_KEY is required"
    );
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
  });

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

  for (const market of markets) {
    if (!market.oracleAddress) continue;

    const request: ResolutionRequest = {
      marketId: market.id,
      oracleAddress: market.oracleAddress,
    };

    try {
      const result = await oracleService.resolve(request);

      assertValidConfidence(result.confidence, market.id);

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

      // Enqueue for on-chain submission.
      //
      // The id is the queue's idempotency key, so it must be a pure function
      // of the resolution — never `Date.now()`. With a timestamped id every
      // poll cycle produced a *new* key, so a retried/duplicated cycle queued
      // the same resolution again and could submit it twice on-chain (#1114).
      await queue.enqueue({
        id: buildSubmissionIdempotencyKey({
          marketId: market.id,
          oracleAddress: market.oracleAddress,
          resolvedAt: result.timestamp,
        }),
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
      // Fail closed: a dependency outage (RPC/DB/Redis) must never be treated
      // as a successful resolution. Surface a stable code and skip the market
      // so no partial report/submission is written.
      const code = isDependencyOutage(error)
        ? ORACLE_ERROR_CODES.DEPENDENCY_UNAVAILABLE
        : error instanceof OracleError
          ? error.code
          : ORACLE_ERROR_CODES.RESOLUTION_FAILED;

      logger.error("Failed to resolve market", {
        marketId: market.id,
        code,
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

  // Log the redacted summary only — never the secret key itself (#1115).
  logger.info("Oracle starting", {
    ...describeOracleConfig(config),
  });

  // Opt-in probe surface (GET /health, GET /health/ready) — disabled unless
  // ORACLE_HEALTH_PORT is set (#1116).
  const healthServer = await startHealthServer({
    logger: {
      info: (fields, message) => logger.info(message, fields),
      warn: (fields, message) => logger.warn(message, fields),
      error: (fields, message) => logger.error(message, fields),
    },
  });

  const shutdown = createShutdown({
    logger,
    timeoutMs: ORACLE_SHUTDOWN_TIMEOUT_MS,
    onShutdown: async () => {
      await healthServer?.close();
      await globalQueue?.close();
      await disconnectPrisma();
      await redis.quit();
    },
  });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const guardedPoll = createOverlapGuardedPoll(poll, logger);
  const intervalMs = config.pollIntervalMs;

  await guardedPoll();
  setInterval(() => void guardedPoll(), intervalMs);
}

// Only auto-bootstrap when executed directly, so importing this module in
// tests (apps/oracle/main.test.ts) never starts the poll loop or health server.
const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  bootstrap().catch((error) => {
    const logger = createLogger("error");
    logger.error("Oracle bootstrap failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
