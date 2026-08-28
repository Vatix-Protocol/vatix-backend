import "dotenv/config";
import { loadConfig } from "./config.js";
import { PollingIngestionLoop } from "./ingestion.js";
import { createLogger } from "./logger.js";
import { InternalIndexerMetricsService } from "./metrics.js";
import { PrismaCursorStorageClient } from "./storage.js";
import { EventFetcher } from "./eventFetcher.js";
import { PrismaBatchWriter } from "./batchWriter.js";
import { checkStartupHealth, checkLiveDependencies } from "./startupHealth.js";
import {
  disconnectPrisma,
  getPrismaClient,
} from "../../../src/services/prisma.js";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  // Fail fast on missing required env (e.g. DATABASE_URL) before touching
  // the database or starting the ingestion loop.
  const health = checkStartupHealth({
    cursor: null,
    networkId: config.networkId,
    cursorKey: config.cursorKey,
    databaseUrl: process.env.DATABASE_URL,
  });
  if (!health.valid) {
    logger.error("Indexer startup health check failed", {
      errors: health.errors,
    });
    throw new Error(`Startup health check failed: ${health.errors.join("; ")}`);
  }

  const metrics = new InternalIndexerMetricsService();
  const storage = new PrismaCursorStorageClient(
    config.networkId,
    config.cursorKey,
    logger
  );
  const eventFetcher = new EventFetcher({
    rpcUrl: config.stellarRpcUrl,
    contractId: config.contractId,
    pageLimit: config.batchSize,
  });
  const batchWriter = new PrismaBatchWriter(logger);

  // Confirm DB and Horizon/Soroban RPC are actually reachable before the
  // poller starts (#947) — checkStartupHealth above only validates config
  // shape, it never touches the network. Running the poller against an
  // unconfirmed dependency can poison the cursor (e.g. commit progress past
  // ledgers a half-broken RPC never really returned).
  const liveHealth = await checkLiveDependencies(
    [
      {
        name: "database",
        check: async () => {
          await getPrismaClient().$queryRaw`SELECT 1`;
        },
      },
      {
        name: "horizon",
        check: async () => {
          await eventFetcher.getLatestLedgerInfo();
        },
      },
    ],
    { nodeEnv: config.nodeEnv }
  );

  if (!liveHealth.ready) {
    logger.error("Indexer dependency health check failed", {
      errors: liveHealth.errors,
      nodeEnv: config.nodeEnv,
    });
    throw new Error(
      `Dependency health check failed: ${liveHealth.errors.join("; ")}`
    );
  }
  logger.info(
    liveHealth.skipped
      ? "Skipped live DB/Horizon health check (non-production)"
      : "Indexer dependencies confirmed ready",
    { nodeEnv: config.nodeEnv }
  );

  // Load optional gap paging config
  const gapPagingWebhookUrl = process.env["INDEXER_GAP_PAGING_WEBHOOK_URL"];
  const gapPagingConfig = gapPagingWebhookUrl
    ? {
        webhookUrl: gapPagingWebhookUrl,
        persistenceCyclesBeforePage: parseInt(
          process.env["INDEXER_GAP_PERSISTENCE_CYCLES"] ?? "3",
          10
        ),
      }
    : undefined;

  const ingestionLoop = new PollingIngestionLoop(
    logger,
    storage,
    metrics,
    config.ingestionIntervalMs,
    config.checkpointFlushEveryBatches,
    {
      eventFetcher,
      batchWriter,
      contractId: config.contractId,
      ledgerWindowSize: config.ledgerWindowSize,
      gapPauseThreshold: config.gapPauseThreshold,
      backfillMaxLedgers: config.backfillMaxLedgers,
      gapPagingConfig,
      nodeEnv: config.nodeEnv,
    }
  );

  logger.info("Indexer bootstrap started", {
    nodeEnv: config.nodeEnv,
    ingestionIntervalMs: config.ingestionIntervalMs,
    ledgerWindowSize: config.ledgerWindowSize,
    networkId: config.networkId,
    cursorKey: config.cursorKey,
    contractId: config.contractId,
    checkpointFlushEveryBatches: config.checkpointFlushEveryBatches,
  });

  const initialCursor = await storage.loadCursor();
  if (initialCursor) {
    const initialSequence = Number(initialCursor);
    if (Number.isFinite(initialSequence)) {
      metrics.setLatestIndexedLedgerSequence(initialSequence);
    }
  }

  logger.info("Loaded persisted cursor", { cursor: initialCursor });

  await ingestionLoop.start(initialCursor);
  logger.info("Indexer startup complete", {
    metrics: metrics.toLogFields(),
  });

  const SHUTDOWN_TIMEOUT_MS = 30_000; // 30 seconds
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    logger.info("Indexer shutdown initiated", {
      signal,
      component: "indexer",
      status: "initiated",
    });

    // Set hard timeout to force exit if shutdown hangs
    const timeoutHandle = setTimeout(() => {
      logger.error("Shutdown timeout exceeded, forcing exit", {
        signal,
        component: "indexer",
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      // Stop ingestion loop and flush checkpoint
      await ingestionLoop.stop();
      await disconnectPrisma();
      clearTimeout(timeoutHandle);

      logger.info("Indexer shutdown complete", {
        signal,
        component: "indexer",
        status: "complete",
        exitCode: 0,
      });
      process.exit(0);
    } catch (error) {
      clearTimeout(timeoutHandle);
      logger.error("Indexer shutdown failed", {
        signal,
        component: "indexer",
        status: "failed",
        exitCode: 1,
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
      message: "Indexer failed during bootstrap",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
