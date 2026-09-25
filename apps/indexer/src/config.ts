import {
  loadIndexerConfig as loadSharedIndexerConfig,
  type IndexerConfig as SharedIndexerConfig,
  ConfigValidationError,
} from "../../../packages/shared/src/config.js";
import {
  loadStellarEndpoints,
  type EndpointConfig,
} from "../../../packages/shared/src/stellarTransport.js";

export type { SharedIndexerConfig };

export const KNOWN_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
} as const;

type Env = Record<string, string | undefined>;

/** Stable error codes for fail-closed env validation. */
export const ENV_ERROR_CODES = {
  ENV_MISSING: "ENV_MISSING",
  ENV_INVALID: "ENV_INVALID",
  ENV_UNSAFE_MAINNET: "ENV_UNSAFE_MAINNET",
} as const;

export type EnvErrorCode =
  (typeof ENV_ERROR_CODES)[keyof typeof ENV_ERROR_CODES];

/**
 * Fail-closed env validation error. Carries a stable error code and the
 * offending variable name only — never the value — so it is safe to log.
 */
export class EnvValidationError extends ConfigValidationError {
  readonly code: EnvErrorCode;
  readonly variable: string;

  constructor(code: EnvErrorCode, variable: string, message: string) {
    super(message);
    this.name = "EnvValidationError";
    this.code = code;
    this.variable = variable;
  }
}

export interface ChainConfig {
  sorobanNetworkPassphrase: string;
  horizonUrl: string;
  horizonUrls: string[];
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

/**
 * Validate the raw environment in a fail-closed manner before any config is
 * loaded. Throws EnvValidationError with a stable code on the first problem.
 * Only variable names and error codes are ever surfaced — never values.
 */
export function validateEnv(env: Env = process.env): void {
  const passphrase = env["SOROBAN_NETWORK_PASSPHRASE"];

  if (!passphrase || passphrase.trim() === "") {
    throw new EnvValidationError(
      ENV_ERROR_CODES.ENV_MISSING,
      "SOROBAN_NETWORK_PASSPHRASE",
      "Missing required environment variable: SOROBAN_NETWORK_PASSPHRASE"
    );
  }

  const known = Object.values(KNOWN_PASSPHRASES) as string[];
  if (!known.includes(passphrase)) {
    throw new EnvValidationError(
      ENV_ERROR_CODES.ENV_INVALID,
      "SOROBAN_NETWORK_PASSPHRASE",
      "Unknown Soroban network passphrase"
    );
  }

  // Mainnet-affecting config requires explicit opt-in. Refuse to boot on
  // mainnet unless the operator has acknowledged it via the opt-in flag.
  if (passphrase === KNOWN_PASSPHRASES.mainnet) {
    const optIn = env["VATIX_ALLOW_MAINNET"];
    if (optIn !== "true" && optIn !== "1") {
      throw new EnvValidationError(
        ENV_ERROR_CODES.ENV_UNSAFE_MAINNET,
        "VATIX_ALLOW_MAINNET",
        "Mainnet passphrase detected without explicit opt-in (set VATIX_ALLOW_MAINNET=true)"
      );
    }
  }
}

export function loadChainConfig(env: Env = process.env): ChainConfig {
  validateEnv(env);

  const passphrase = env["SOROBAN_NETWORK_PASSPHRASE"] as string;

  const { horizonUrls } = loadStellarEndpoints(env, passphrase);
  const horizonUrl = horizonUrls[0];

  return { sorobanNetworkPassphrase: passphrase, horizonUrl, horizonUrls };
}

/** Unified indexer bootstrap config (shared env + chain parser env). */
export function loadConfig(env: Env = process.env): IndexerAppConfig {
  validateEnv(env);
  return {
    ...loadSharedIndexerConfig(env),
    ...loadChainConfig(env),
  };
}

/** @deprecated Use loadChainConfig — kept for existing tests. */
export function loadIndexerConfig(env: Env = process.env): ChainConfig {
  return loadChainConfig(env);
}
