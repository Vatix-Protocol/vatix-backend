import { loadIndexerContractId } from "../../../../packages/shared/src/config.js";

export interface ResolvedOracleStellarConfig {
  rpcUrl: string;
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
 */
export function resolveOracleStellarConfig(
  env: NodeJS.ProcessEnv
): ResolvedOracleStellarConfig | undefined {
  const rpcUrl = env.STELLAR_RPC_URL;
  const networkPassphrase = env.SOROBAN_NETWORK_PASSPHRASE;
  const signerSecret = env.ORACLE_SECRET_KEY;

  let contractId: string | undefined;
  try {
    contractId = loadIndexerContractId(env);
  } catch {
    contractId = undefined;
  }

  return rpcUrl && contractId && networkPassphrase && signerSecret
    ? { rpcUrl, contractId, networkPassphrase, signerSecret }
    : undefined;
}
