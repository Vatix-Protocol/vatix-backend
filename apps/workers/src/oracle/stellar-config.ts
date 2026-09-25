import { loadIndexerContractId } from "../../../../packages/shared/src/config.js";
import { loadStellarEndpoints } from "../../../../packages/shared/src/stellarTransport.js";

export interface ResolvedOracleStellarConfig {
  rpcUrl: string;
  rpcUrls: string[];
  contractId: string;
  networkPassphrase: string;
  signerSecret: string;
}

/**
 * Known Stellar network passphrases, keyed by the deployment identifier used
 * in STELLAR_NETWORK. Mirrors apps/indexer/src/config.ts's KNOWN_PASSPHRASES
 * so the oracle worker recognizes the same set of networks.
 */
export const KNOWN_STELLAR_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
} as const;

/** Thrown when a configured network passphrase doesn't match the deployment. */
export class StellarNetworkMismatchError extends Error {
  constructor(deploymentNetwork: string, expected: string, actual: string) {
    super(
      `SOROBAN_NETWORK_PASSPHRASE does not match STELLAR_NETWORK="${deploymentNetwork}": ` +
        `expected "${expected}" but got "${actual}"`
    );
    this.name = "StellarNetworkMismatchError";
  }
}

/**
 * Throws StellarNetworkMismatchError when networkPassphrase doesn't match the
 * passphrase known for deploymentNetwork. Unrecognized deployment networks
 * (e.g. futurenet, a custom standalone network) are skipped rather than
 * rejected, since we have no known-good passphrase to compare against.
 */
export function assertPassphraseMatchesDeployment(
  networkPassphrase: string,
  deploymentNetwork: string
): void {
  const normalized = deploymentNetwork.trim().toLowerCase();
  const expected = (
    KNOWN_STELLAR_PASSPHRASES as Record<string, string | undefined>
  )[normalized];

  if (expected && expected !== networkPassphrase) {
    throw new StellarNetworkMismatchError(
      normalized,
      expected,
      networkPassphrase
    );
  }
}

/**
 * Builds the on-chain submission config from env vars, or returns undefined
 * when any required var is missing (resolve_market calls are then disabled).
 * Contract ID resolution defers to the shared loader so this worker matches
 * the INDEXER_CONTRACT_ID-first precedence used by the indexer, instead of
 * re-implementing (and inverting) that precedence locally.
 *
 * Once all four vars are present, the resolved networkPassphrase must match
 * the passphrase known for STELLAR_NETWORK (default "testnet") — this is
 * what stops a misconfigured passphrase from silently submitting to the
 * wrong network. See assertPassphraseMatchesDeployment.
 *
 * Dev/test callers: this function returns undefined on incomplete config,
 * allowing lenient startup for local development. Production callers should
 * use validateAndResolveStellarConfig() instead.
 */
export function resolveOracleStellarConfig(
  env: NodeJS.ProcessEnv
): ResolvedOracleStellarConfig | undefined {
  const networkPassphrase = env.SOROBAN_NETWORK_PASSPHRASE;
  const signerSecret = env.ORACLE_SECRET_KEY;

  // Require an explicit RPC endpoint. loadStellarEndpoints applies public
  // defaults, but the oracle worker must not silently submit against those.
  const hasExplicitRpc =
    Boolean(env.STELLAR_RPC_URL?.trim()) ||
    Boolean(env.STELLAR_RPC_URLS?.trim());

  let contractId: string | undefined;
  try {
    contractId = loadIndexerContractId(env);
  } catch {
    contractId = undefined;
  }

  if (!(hasExplicitRpc && contractId && networkPassphrase && signerSecret)) {
    return undefined;
  }

  const { rpcUrls } = loadStellarEndpoints(env, networkPassphrase);

  assertPassphraseMatchesDeployment(
    networkPassphrase,
    env.STELLAR_NETWORK ?? "testnet"
  );

  return {
    rpcUrl: rpcUrls[0],
    rpcUrls,
    contractId,
    networkPassphrase,
    signerSecret,
  };
}

/** Thrown when production startup is attempted with incomplete Stellar config. */
export class IncompleteProductionStellarConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Production startup requires complete Stellar configuration. Missing: ${missing.join(", ")}. ` +
        `Set STELLAR_RPC_URL (or STELLAR_RPC_URLS), contract ID (INDEXER_CONTRACT_ID or MARKET_CONTRACT_ID), ` +
        `SOROBAN_NETWORK_PASSPHRASE, and ORACLE_SECRET_KEY (or STELLAR_SECRET_KEY for settlement) to proceed.`
    );
    this.name = "IncompleteProductionStellarConfigError";
  }
}

/**
 * Validates and resolves Stellar config, throwing in production when required
 * environment variables are missing. In dev/test (NODE_ENV !== "production"),
 * delegates to resolveOracleStellarConfig() for lenient behavior.
 *
 * @param env Process environment variables
 * @param nodeEnv The NODE_ENV value (defaults to process.env.NODE_ENV)
 * @returns Resolved Stellar config, or undefined in dev/test when incomplete
 * @throws IncompleteProductionStellarConfigError if production + incomplete
 */
export function validateAndResolveStellarConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string = process.env.NODE_ENV ?? "development"
): ResolvedOracleStellarConfig | undefined {
  // In dev/test, allow lenient resolution
  if (nodeEnv !== "production") {
    return resolveOracleStellarConfig(env);
  }

  // Production: fail fast if any required var is missing
  const networkPassphrase = env.SOROBAN_NETWORK_PASSPHRASE;
  const signerSecret = env.ORACLE_SECRET_KEY;

  const hasExplicitRpc =
    Boolean(env.STELLAR_RPC_URL?.trim()) ||
    Boolean(env.STELLAR_RPC_URLS?.trim());

  let contractId: string | undefined;
  try {
    contractId = loadIndexerContractId(env);
  } catch {
    contractId = undefined;
  }

  const missing: string[] = [];
  if (!hasExplicitRpc) {
    missing.push("STELLAR_RPC_URL or STELLAR_RPC_URLS");
  }
  if (!contractId) {
    missing.push("INDEXER_CONTRACT_ID or MARKET_CONTRACT_ID");
  }
  if (!networkPassphrase) {
    missing.push("SOROBAN_NETWORK_PASSPHRASE");
  }
  if (!signerSecret) {
    missing.push("ORACLE_SECRET_KEY");
  }

  if (missing.length > 0) {
    throw new IncompleteProductionStellarConfigError(missing);
  }

  const { rpcUrls } = loadStellarEndpoints(env, networkPassphrase);

  assertPassphraseMatchesDeployment(
    networkPassphrase,
    env.STELLAR_NETWORK ?? "testnet"
  );

  return {
    rpcUrl: rpcUrls[0],
    rpcUrls,
    contractId,
    networkPassphrase,
    signerSecret,
  };
}
