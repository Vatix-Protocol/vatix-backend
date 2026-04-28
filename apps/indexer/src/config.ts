export interface IndexerConfig {
  ingestionIntervalMs: number;
  networkId: string;
  cursorKey: string;
  checkpointFlushEveryBatches: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

const DEFAULT_INGESTION_INTERVAL_MS = 5_000;
const DEFAULT_NETWORK_ID = "mainnet";
const DEFAULT_CURSOR_KEY = "ingestion";
const DEFAULT_CHECKPOINT_FLUSH_EVERY_BATCHES = 10;
const DEFAULT_LOG_LEVEL: IndexerConfig["logLevel"] = "info";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const ingestionIntervalMs = Number(
    env.INDEXER_INGESTION_INTERVAL_MS ?? DEFAULT_INGESTION_INTERVAL_MS
  );

  if (!Number.isFinite(ingestionIntervalMs) || ingestionIntervalMs < 100) {
    throw new Error("INDEXER_INGESTION_INTERVAL_MS must be a number >= 100");
  }

  const logLevel = (env.INDEXER_LOG_LEVEL ?? DEFAULT_LOG_LEVEL) as IndexerConfig["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new Error("INDEXER_LOG_LEVEL must be one of debug|info|warn|error");
  }

  const networkId = (env.INDEXER_NETWORK_ID ?? DEFAULT_NETWORK_ID).trim();
  if (!networkId) {
    throw new Error("INDEXER_NETWORK_ID must be a non-empty string");
  }

  const cursorKey = (env.INDEXER_CURSOR_KEY ?? DEFAULT_CURSOR_KEY).trim();
  if (!cursorKey) {
    throw new Error("INDEXER_CURSOR_KEY must be a non-empty string");
  }

  const checkpointFlushEveryBatches = Number(
    env.INDEXER_CHECKPOINT_FLUSH_EVERY_BATCHES ??
      DEFAULT_CHECKPOINT_FLUSH_EVERY_BATCHES
  );
  if (
    !Number.isInteger(checkpointFlushEveryBatches) ||
    checkpointFlushEveryBatches < 1
  ) {
    throw new Error("INDEXER_CHECKPOINT_FLUSH_EVERY_BATCHES must be an integer >= 1");
  }

  return {
    ingestionIntervalMs,
    networkId,
    cursorKey,
    checkpointFlushEveryBatches,
    logLevel,
  };
}
