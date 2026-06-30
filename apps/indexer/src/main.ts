import "dotenv/config";
import { loadConfig } from "./config.js";
import { PollingIngestionLoop } from "./ingestion.js";
import { createLogger } from "./logger.js";
import { InternalIndexerMetricsService } from "./metrics.js";
import { PrismaCursorStorageClient } from "./storage.js";
import { EventFetcher } from "./eventFetcher.js";
import { PrismaBatchWriter } from "./batchWriter.js";
import { disconnectPrisma } from "../../../src/services/prisma.js";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const metrics = new InternalIndexerMetricsService();
  const storage = new PrismaCursorStorageClient(
    config.networkId,
    config.cursorKey,
    logger
  );
  const eventFetcher = new EventFetcher({
    rpcUrl: config.stellarRpcUrl,
    contractId: config.contractId,
  });
  const batchWriter = new PrismaBatchWriter(logger);
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
