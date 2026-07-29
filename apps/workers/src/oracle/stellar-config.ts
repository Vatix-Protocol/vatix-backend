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
 */
export function resolveOracleStellarConfig(
  env: NodeJS.ProcessEnv
): ResolvedOracleStellarConfig | undefined {
  const networkPassphrase = env.SOROBAN_NETWORK_PASSPHRASE;
  const signerSecret = env.ORACLE_SECRET_KEY;

  const { rpcUrls } = loadStellarEndpoints(env, networkPassphrase);

  let contractId: string | undefined;
  try {
    contractId = loadIndexerContractId(env);
  } catch {
    contractId = undefined;
  }

  if (!(rpcUrl && contractId && networkPassphrase && signerSecret)) {
    return undefined;
  }

  assertPassphraseMatchesDeployment(
    networkPassphrase,
    env.STELLAR_NETWORK ?? "testnet"
  );

  return { rpcUrl, contractId, networkPassphrase, signerSecret };
}
