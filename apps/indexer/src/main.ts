import "dotenv/config";
import { loadConfig } from "./config.js";
import { PollingIngestionLoop } from "./ingestion.js";
import { createLogger } from "./logger.js";
import { InternalIndexerMetricsService } from "./metrics.js";
import { PrismaCursorStorageClient } from "./storage.js";
import { disconnectPrisma } from "../../../src/services/prisma.js";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const metrics = new InternalIndexerMetricsService();
  const storage = new PrismaCursorStorageClient(
    config.networkId,
    config.cursorKey
  );
  const ingestionLoop = new PollingIngestionLoop(
    logger,
    storage,
    metrics,
    config.ingestionIntervalMs,
    config.checkpointFlushEveryBatches
  );

  logger.info("Indexer bootstrap started", {
    ingestionIntervalMs: config.ingestionIntervalMs,
    networkId: config.networkId,
    cursorKey: config.cursorKey,
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
    metrics: metrics.getSnapshot(),
  });

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    logger.info("Indexer shutdown initiated", { signal });

    try {
      await ingestionLoop.stop();
      await disconnectPrisma();
      logger.info("Indexer shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error("Indexer shutdown failed", {
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
