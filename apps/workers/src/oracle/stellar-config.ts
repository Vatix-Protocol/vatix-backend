import { loadIndexerContractId } from "../../../../packages/shared/src/config.js";
import { loadStellarEndpoints } from "../../../../packages/shared/src/stellarTransport.js";
import {
  KNOWN_NETWORK_PASSPHRASES,
  StellarNetworkConsistencyError,
  assertEndpointMatchesNetwork,
  assertNetworkPassphraseMatches,
  assertStellarNetworkConsistency,
  knownPassphraseForNetwork,
  normalizeStellarNetwork,
  warnUnverifiableStellarEndpoints,
} from "../../../../packages/shared/src/networkConsistency.js";

export interface ResolvedOracleStellarConfig {
  rpcUrl: string;
  rpcUrls: string[];
  contractId: string;
  networkPassphrase: string;
  signerSecret: string;
}

/**
 * Known Stellar network passphrases, keyed by the deployment identifier used
 * in STELLAR_NETWORK. Re-exported from
 * packages/shared/src/networkConsistency.ts so the oracle worker, the indexer,
 * and the API all recognize the same set of networks (#1133).
 */
export const KNOWN_STELLAR_PASSPHRASES = KNOWN_NETWORK_PASSPHRASES;

/**
 * Thrown when a configured network passphrase doesn't match the deployment.
 * Extends the shared fail-closed error so callers that only know about
 * packages/shared/src/networkConsistency.ts still catch it, while existing
 * oracle-worker callers can keep matching on the concrete class.
 */
export class StellarNetworkMismatchError extends StellarNetworkConsistencyError {
  constructor(deploymentNetwork: string, expected: string, actual: string) {
    super(
      "SOROBAN_NETWORK_PASSPHRASE",
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
 *
 * The comparison itself is delegated to the shared
 * `assertNetworkPassphraseMatches()` (#1133) so the API, indexer, and workers
 * cannot drift apart on which passphrase belongs to which network; only the
 * error type is localized here for backward compatibility.
 */
export function assertPassphraseMatchesDeployment(
  networkPassphrase: string,
  deploymentNetwork: string
): void {
  try {
    assertNetworkPassphraseMatches(networkPassphrase, deploymentNetwork);
  } catch (err) {
    if (!(err instanceof StellarNetworkConsistencyError)) throw err;

    const normalized = normalizeStellarNetwork(deploymentNetwork);
    throw new StellarNetworkMismatchError(
      normalized,
      knownPassphraseForNetwork(normalized) ?? "unknown",
      networkPassphrase
    );
  }
}

/**
 * #1134 / #1135 — every configured Soroban RPC endpoint must serve the network
 * named by STELLAR_NETWORK. Throws StellarNetworkConsistencyError on drift.
 */
export function assertRpcEndpointsMatchDeployment(
  env: NodeJS.ProcessEnv
): void {
  const network = env.STELLAR_NETWORK ?? "testnet";
  // Name the variable the entry was actually read from: a drift reported
  // against STELLAR_RPC_URL when the operator set STELLAR_RPC_URLS sends them
  // to the wrong variable (and breaks log scraping on the documented
  // variable-name-only contract, docs/env-validation.md).
  const variable = env.STELLAR_RPC_URLS?.trim()
    ? "STELLAR_RPC_URLS"
    : "STELLAR_RPC_URL";
  const raw = env.STELLAR_RPC_URLS?.trim() || env.STELLAR_RPC_URL?.trim() || "";

  for (const url of raw.split(",")) {
    const candidate = url.trim();
    if (!candidate) continue;
    assertEndpointMatchesNetwork(candidate, network, "rpc", variable);
  }

  warnUnverifiableStellarEndpoints(env, env.NODE_ENV);
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

  // #1135 — the RPC endpoints the worker will submit through must serve the
  // declared network, otherwise settlement signatures go to the wrong chain.
  assertRpcEndpointsMatchDeployment(env);

  // #1133 / #1134 / #1135 — the full shared gate. The two checks above cover
  // the passphrase and the RPC list this worker resolves; the gate additionally
  // validates STELLAR_HORIZON_URL(S) (#1134) and *every* configured endpoint
  // variable, including the ones loadStellarEndpoints() does not prefer. It
  // runs in every environment, matching the API, the indexer and the settlement
  // worker: a half-rotated deployment must not boot an oracle worker that
  // signs and submits on one chain while the rest of the stack points at
  // another (docs/env-validation.md). Custom networks and non-Stellar hosts
  // stay exempt, exactly as documented there.
  assertStellarNetworkConsistency(env);

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

  // Production runs the full consistency gate: passphrase (#1133) plus every
  // configured Horizon/RPC endpoint (#1134, #1135) against STELLAR_NETWORK.
  assertStellarNetworkConsistency(env);

  return {
    rpcUrl: rpcUrls[0],
    rpcUrls,
    contractId,
    networkPassphrase,
    signerSecret,
  };
}
