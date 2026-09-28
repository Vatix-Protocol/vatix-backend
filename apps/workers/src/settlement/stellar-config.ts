/**
 * Settlement Stellar configuration — network consistency gate.
 *
 * `apps/oracle` keeps the equivalent validation in a standalone
 * `stellar-config.ts` (issue #1133) so it can be unit tested without booting
 * the worker; this module is the settlement worker's counterpart.
 *
 * Why it is separate from `consumer.ts`: the entrypoint calls `bootstrap()` at
 * module load, so importing it from a test would start a BullMQ worker. The
 * oracle worker solved this the same way.
 *
 * The gate itself is `assertStellarNetworkConsistency()` from
 * `packages/shared/src/networkConsistency.ts` — the shared #1133/#1134/#1135
 * implementation. The indexer (`apps/indexer/src/config.ts`), the API
 * (`src/env.ts`) and the oracle worker
 * (`apps/workers/src/oracle/stellar-config.ts`) all call it. The settlement
 * worker did not: `validateSettlementStellarConfig()` only checked that
 * STELLAR_RPC_URL, SETTLEMENT_CONTRACT_ID, SOROBAN_NETWORK_PASSPHRASE and
 * STELLAR_SECRET_KEY were *present*, never that they described the same chain
 * as STELLAR_NETWORK. A settlement worker configured with a testnet passphrase
 * and a mainnet `STELLAR_RPC_URL` therefore booted and submitted on-chain
 * transactions signed for one network to the other — the exact drift
 * #1133/#1135 exist to prevent, on the money path.
 *
 * @module apps/workers/src/settlement/stellar-config
 */
import {
  assertStellarNetworkConsistency,
  StellarNetworkConsistencyError,
} from "../../../../packages/shared/src/networkConsistency.js";
import { loadStellarEndpoints } from "../../../../packages/shared/src/stellarTransport.js";
import type { SettlementStellarConfig } from "./settlement-worker.js";

/** Thrown when production startup is attempted with incomplete settlement Stellar config. */
export class IncompleteProductionSettlementConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Production startup requires complete Stellar configuration for settlement. Missing: ${missing.join(", ")}. ` +
        `Set STELLAR_RPC_URL (or STELLAR_RPC_URLS), SETTLEMENT_CONTRACT_ID, ` +
        `SOROBAN_NETWORK_PASSPHRASE, and STELLAR_SECRET_KEY to proceed.`
    );
    this.name = "IncompleteProductionSettlementConfigError";
  }
}

/**
 * Validates settlement Stellar config, throwing when any required variable is
 * missing in production. In dev/test, returns undefined for incomplete config
 * (allowing lenient startup).
 *
 * Fail-closed network consistency (#1133 passphrase, #1134 Horizon URL, #1135
 * Soroban RPC URL): the passphrase and every configured endpoint must describe
 * the same chain as STELLAR_NETWORK, otherwise the worker would sign for one
 * network and submit to another. The gate runs in *every* environment — the
 * upstream boot gates do the same — because a drifted settlement worker is a
 * money-path failure, and dev/test drift is exactly how it reaches production.
 *
 * @throws {StellarNetworkConsistencyError} on passphrase/endpoint drift
 * @throws {IncompleteProductionSettlementConfigError} in production when a
 *   required variable is missing
 */
export function validateSettlementStellarConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string = process.env.NODE_ENV ?? "development"
): SettlementStellarConfig | undefined {
  const contractId = env.SETTLEMENT_CONTRACT_ID;
  const networkPassphrase = env.SOROBAN_NETWORK_PASSPHRASE;
  const signerSecret = env.STELLAR_SECRET_KEY;

  const hasExplicitRpc =
    Boolean(env.STELLAR_RPC_URL?.trim()) ||
    Boolean(env.STELLAR_RPC_URLS?.trim());

  // Network consistency gate (#1133/#1134/#1135). Runs before loadStellarEndpoints
  // so a drifted deployment never resolves an endpoint at all.
  assertStellarNetworkConsistency(env);

  const { rpcUrls } = loadStellarEndpoints(env, networkPassphrase);
  const rpcUrl = rpcUrls[0];

  // In dev/test, allow incomplete config
  if (nodeEnv !== "production") {
    return rpcUrl && contractId && networkPassphrase && signerSecret
      ? { rpcUrl, rpcUrls, contractId, networkPassphrase, signerSecret }
      : undefined;
  }

  // Production: fail fast
  const missing: string[] = [];
  if (!hasExplicitRpc) {
    missing.push("STELLAR_RPC_URL or STELLAR_RPC_URLS");
  }
  if (!contractId) {
    missing.push("SETTLEMENT_CONTRACT_ID");
  }
  if (!networkPassphrase) {
    missing.push("SOROBAN_NETWORK_PASSPHRASE");
  }
  if (!signerSecret) {
    missing.push("STELLAR_SECRET_KEY");
  }

  if (missing.length > 0) {
    throw new IncompleteProductionSettlementConfigError(missing);
  }

  return {
    rpcUrl,
    rpcUrls,
    contractId,
    networkPassphrase,
    signerSecret,
  };
}
