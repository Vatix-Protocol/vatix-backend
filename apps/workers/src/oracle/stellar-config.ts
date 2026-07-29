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
 * Builds the on-chain submission config from env vars, or returns undefined
 * when any required var is missing (resolve_market calls are then disabled).
 * Contract ID resolution defers to the shared loader so this worker matches
 * the INDEXER_CONTRACT_ID-first precedence used by the indexer, instead of
 * re-implementing (and inverting) that precedence locally.
 *
 * Supports multiple RPC endpoints via STELLAR_RPC_URLS (comma-separated)
 * with fallback to single STELLAR_RPC_URL for backward compatibility.
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

  return rpcUrls.length > 0 && contractId && networkPassphrase && signerSecret
    ? {
        rpcUrl: rpcUrls[0],
        rpcUrls,
        contractId,
        networkPassphrase,
        signerSecret,
      }
    : undefined;
}
