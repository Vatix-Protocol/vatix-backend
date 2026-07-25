import {
  loadIndexerConfig as loadSharedIndexerConfig,
  type IndexerConfig as SharedIndexerConfig,
  ConfigValidationError,
} from "../../../packages/shared/src/config.js";

export type { SharedIndexerConfig };

export const KNOWN_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
} as const;

type Env = Record<string, string | undefined>;

export interface ChainConfig {
  sorobanNetworkPassphrase: string;
  horizonUrl: string;
}

export interface IngestionLoopConfig {
  ingestionIntervalMs: number;
  ledgerWindowSize: number;
  checkpointFlushEveryBatches: number;
  contractId: string;
}

export interface IndexerAppConfig extends SharedIndexerConfig, ChainConfig {}

export function pickIngestionLoopConfig(
  cfg: IndexerAppConfig
): IngestionLoopConfig {
  return {
    ingestionIntervalMs: cfg.ingestionIntervalMs,
    ledgerWindowSize: cfg.ledgerWindowSize,
    checkpointFlushEveryBatches: cfg.checkpointFlushEveryBatches,
    contractId: cfg.contractId,
  };
}

export function loadChainConfig(env: Env = process.env): ChainConfig {
  const passphrase = env["SOROBAN_NETWORK_PASSPHRASE"];

  if (!passphrase || passphrase.trim() === "") {
    throw new ConfigValidationError(
      "Missing required environment variable: SOROBAN_NETWORK_PASSPHRASE"
    );
  }

  const known = Object.values(KNOWN_PASSPHRASES) as string[];
  if (!known.includes(passphrase)) {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        message: "Unknown Soroban network passphrase",
        passphrase,
      }) + "\n"
    );
  }

  const horizonUrl =
    env["STELLAR_HORIZON_URL"] ??
    (passphrase === KNOWN_PASSPHRASES.mainnet
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org");

  return { sorobanNetworkPassphrase: passphrase, horizonUrl };
}

/** Unified indexer bootstrap config (shared env + chain parser env). */
export function loadConfig(env: Env = process.env): IndexerAppConfig {
  return {
    ...loadSharedIndexerConfig(env),
    ...loadChainConfig(env),
  };
}

/** @deprecated Use loadChainConfig — kept for existing tests. */
export function loadIndexerConfig(env: Env = process.env): ChainConfig {
  return loadChainConfig(env);
}
