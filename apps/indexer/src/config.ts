export interface IndexerConfig {
  nodeEnv: "development" | "test" | "production";
  stellarRpcUrl: string;
  ingestionIntervalMs: number;
  networkId: string;
  cursorKey: string;
  checkpointFlushEveryBatches: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

const ACCEPTED_NODE_ENVS = ["development", "test", "production"] as const;
type NodeEnv = (typeof ACCEPTED_NODE_ENVS)[number];

const DEFAULT_INGESTION_INTERVAL_MS = 5_000;
const DEFAULT_NETWORK_ID = "mainnet";
const DEFAULT_CURSOR_KEY = "ingestion";
const DEFAULT_CHECKPOINT_FLUSH_EVERY_BATCHES = 10;
const DEFAULT_LOG_LEVEL: IndexerConfig["logLevel"] = "info";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const rawNodeEnv = env.NODE_ENV ?? "development";
  if (!ACCEPTED_NODE_ENVS.includes(rawNodeEnv as NodeEnv)) {
    throw new Error(
      `NODE_ENV must be one of ${ACCEPTED_NODE_ENVS.join(" | ")}, got: ${JSON.stringify(rawNodeEnv)}`
    );
  }
  const nodeEnv = rawNodeEnv as NodeEnv;

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

  const rawRpcUrl = env.STELLAR_RPC_URL;
  if (!rawRpcUrl || rawRpcUrl.trim() === "") {
    throw new Error("Missing required environment variable: STELLAR_RPC_URL");
  }
  let parsedRpcUrl: URL;
  try {
    parsedRpcUrl = new URL(rawRpcUrl);
  } catch {
    throw new Error(
      "STELLAR_RPC_URL is not a valid URL (expected format: https://soroban-testnet.stellar.org)"
    );
  }
  if (parsedRpcUrl.protocol !== "https:" && parsedRpcUrl.protocol !== "http:") {
    throw new Error(
      `STELLAR_RPC_URL must use http:// or https://, got: ${JSON.stringify(parsedRpcUrl.protocol)}`
    );
  }
  const stellarRpcUrl = rawRpcUrl.trim();

  return {
    nodeEnv,
    stellarRpcUrl,
    ingestionIntervalMs,
    networkId,
    cursorKey,
    checkpointFlushEveryBatches,
    logLevel,
  };
}
