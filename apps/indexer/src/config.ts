import {
  loadIndexerConfig as loadSharedIndexerConfig,
  loadIndexerContractId,
  type IndexerConfig as SharedIndexerConfig,
  ConfigValidationError,
} from "../../../packages/shared/src/config.js";
import {
  loadStellarEndpoints,
  type EndpointConfig,
} from "../../../packages/shared/src/stellarTransport.js";
import {
  KNOWN_NETWORK_PASSPHRASES,
  StellarNetworkConsistencyError,
  assertStellarNetworkConsistency,
  warnUnverifiableStellarEndpoints,
} from "../../../packages/shared/src/networkConsistency.js";

export type { SharedIndexerConfig };

/**
 * Known Stellar network passphrases keyed by `STELLAR_NETWORK` value.
 * Re-exported from packages/shared/src/networkConsistency.ts so the indexer,
 * the API, and the workers all share one list (#1133).
 */
export const KNOWN_PASSPHRASES = KNOWN_NETWORK_PASSPHRASES;

type Env = Record<string, string | undefined>;

/** Stable error codes for fail-closed env validation. */
export const ENV_ERROR_CODES = {
  ENV_MISSING: "ENV_MISSING",
  ENV_INVALID: "ENV_INVALID",
  ENV_UNSAFE_MAINNET: "ENV_UNSAFE_MAINNET",
  /** Passphrase / Horizon URL / Soroban RPC URL disagree with STELLAR_NETNETWORK. */
  ENV_NETWORK_MISMATCH: "ENV_NETWORK_MISMATCH",
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
    // The stable code leads the message so log lines and test assertions can
    // match on it (e.g. /ENV_MISSING/) without a second lookup — matching the
    // documented `[env] ENV_MISSING: DATABASE_URL` shape in docs/env-validation.md.
    super(`${code}: ${message}`, { code, variable });
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
 * Unknown passphrases (custom networks like futurenet/standalone) are allowed
 * with a warning to support test deployments, but mainnet requires explicit opt-in.
 *
 * The target contract ID is validated here too (#1132): a boot without it would
 * start an ingestion loop that connects, polls, and silently indexes nothing.
 * `loadIndexerContractId` owns presence/precedence/format rules (including the
 * production strkey check) so the indexer, oracle worker, and CLI share one
 * implementation; this gate only re-labels its errors with the indexer's
 * stable codes.
 */
export function validateEnv(env: Env = process.env): void {
  const passphrase = env["SOROBAN_NETWORK_PASSPHRASE"];

  if (passphrase === undefined || passphrase === "") {
    throw new EnvValidationError(
      ENV_ERROR_CODES.ENV_MISSING,
      "SOROBAN_NETWORK_PASSPHRASE",
      "Missing required environment variable: SOROBAN_NETWORK_PASSPHRASE"
    );
  }

  if (passphrase.trim() === "") {
    // Present but blank is a malformed value, not a missing one — the
    // distinction matters for ops alerting (docs/env-validation.md).
    throw new EnvValidationError(
      ENV_ERROR_CODES.ENV_INVALID,
      "SOROBAN_NETWORK_PASSPHRASE",
      "SOROBAN_NETWORK_PASSPHRASE must not be blank"
    );
  }

  const known = Object.values(KNOWN_PASSPHRASES) as string[];

  if (!known.includes(passphrase)) {
    // Warn for custom/unknown networks but allow them (futurenet, standalone,
    // etc.). The passphrase value is deliberately NOT logged — only the
    // variable name, per the secret-handling rule in docs/env-validation.md.
    console.warn(
      "[env] WARNING: SOROBAN_NETWORK_PASSPHRASE does not match any known " +
        `Stellar network. Known networks: ${known.join(", ")}. ` +
        "Proceeding with custom network configuration."
    );
  }

  // Network consistency gate (#1133 passphrase, #1134 Horizon URL,
  // #1135 Soroban RPC URL): the passphrase and every configured endpoint must
  // describe the same chain as STELLAR_NETWORK. Fail closed before the
  // ingestion loop starts so the indexer can never poll one chain and stamp
  // its ledger cursor with another chain's state.
  try {
    assertStellarNetworkConsistency(env);
  } catch (err) {
    if (err instanceof StellarNetworkConsistencyError) {
      // EnvValidationError prefixes the stable code itself; drop the copy the
      // shared error already carries so the log line is not doubled.
      throw new EnvValidationError(
        ENV_ERROR_CODES.ENV_NETWORK_MISMATCH,
        err.variable,
        err.message.replace(/^ENV_NETWORK_MISMATCH:\s*/, "")
      );
    }
    throw err;
  }
  warnUnverifiableStellarEndpoints(env, env.NODE_ENV);

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

  // Contract ID boot gate (#1132). Place after the passphrase checks so the
  // network is validated first, and fail closed in every environment — the
  // indexer has nothing to ingest without a target contract.
  try {
    loadIndexerContractId(env);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      throw new EnvValidationError(
        err.code === ENV_ERROR_CODES.ENV_INVALID
          ? ENV_ERROR_CODES.ENV_INVALID
          : ENV_ERROR_CODES.ENV_MISSING,
        err.variable ?? "INDEXER_CONTRACT_ID",
        err.message
      );
    }
    throw err;
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
