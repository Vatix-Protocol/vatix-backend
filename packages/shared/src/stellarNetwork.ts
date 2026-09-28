/**
 * Stellar network consistency checks — issues #1133, #1134, #1135.
 *
 * The network passphrase, the Horizon URL, and the Soroban RPC URL are three
 * separate env vars that must all describe the *same* network. Nothing in
 * Stellar's SDKs stops a process from pairing the testnet passphrase with a
 * mainnet Horizon host: signatures, tx envelopes, and ledger reads would then
 * be built for one chain and submitted to another — the classic "address
 * drift" failure that produces wrong liquidity/settlement behaviour rather
 * than an obvious crash.
 *
 * Invariants enforced here (fail-closed in every environment, so a drifted
 * deployment cannot boot at all):
 *
 *   1. A passphrase declared through `STELLAR_NETWORK` must equal the
 *      passphrase known for that network.                     (#1133)
 *   2. Every configured Horizon URL must be a host known to serve the network
 *      the passphrase names.                                 (#1134)
 *   3. Every configured Soroban RPC URL must likewise match. (#1135)
 *
 * Only *public Stellar hosts* are classified. Self-hosted / proxied /
 * localhost endpoints carry no network signal, so they are left alone rather
 * than guessed at — the check is deny-by-default (unknown host ⇒ no verdict)
 * instead of fail-closed on configuration the operator may legitimately
 * control.
 *
 * All errors carry the stable code `ENV_NETWORK_MISMATCH` and the offending
 * *variable name* only, never the value, so they are safe to log.
 *
 * @module packages/shared/src/stellarNetwork
 */

import {
  CONFIG_ERROR_CODES,
  ConfigValidationError,
  type Env,
} from "./config.js";

/** Stable error code for "configured values describe different networks". */
export const ENV_NETWORK_MISMATCH = "ENV_NETWORK_MISMATCH";

/** Networks whose passphrase we know exactly. */
export const KNOWN_STELLAR_NETWORKS = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
} as const;

export type StellarNetworkName = keyof typeof KNOWN_STELLAR_NETWORKS;

/** Public Stellar hostnames, mapped to the network they serve. */
const KNOWN_HORIZON_HOSTS: Readonly<Record<string, StellarNetworkName>> = {
  "horizon.stellar.org": "mainnet",
  "horizon-testnet.stellar.org": "testnet",
};

const KNOWN_RPC_HOSTS: Readonly<Record<string, StellarNetworkName>> = {
  "soroban.stellar.org": "mainnet",
  "soroban-mainnet.stellar.org": "mainnet",
  "soroban-testnet.stellar.org": "testnet",
};

/**
 * Fail-closed network consistency error. Reuses {@link ConfigValidationError}
 * so existing boot gates can re-label it with their own stable codes, and
 * carries the variable name only — never the value.
 */
export class StellarNetworkConfigError extends ConfigValidationError {
  constructor(variable: string, message: string) {
    super(`${ENV_NETWORK_MISMATCH}: ${message}`, {
      code: CONFIG_ERROR_CODES.ENV_INVALID,
      variable,
    });
    this.name = "StellarNetworkConfigError";
  }
}

/**
 * Map a network passphrase to its network name, or "unknown" for custom
 * networks (futurenet, standalone, local test chains).
 */
export function classifyNetworkPassphrase(
  passphrase: string | undefined
): StellarNetworkName | "unknown" {
  const normalized = passphrase?.trim();
  for (const [name, known] of Object.entries(KNOWN_STELLAR_NETWORKS)) {
    if (normalized === known) return name as StellarNetworkName;
  }
  return "unknown";
}

function isKnownNetworkName(
  value: string | undefined
): value is StellarNetworkName {
  return (
    value !== undefined &&
    Object.prototype.hasOwnProperty.call(KNOWN_STELLAR_NETWORKS, value)
  );
}

/**
 * Check that `SOROBAN_NETWORK_PASSPHRASE` matches the network declared by
 * `STELLAR_NETWORK` (#1133). An unrecognised deployment network (futurenet,
 * standalone) is skipped — there is no known-good passphrase to compare
 * against, and rejecting it would break legitimate private deployments.
 *
 * @param variable the env var to blame when a mismatch is found
 */
export function assertPassphraseMatchesDeployment(
  passphrase: string,
  deploymentNetwork: string | undefined,
  variable = "SOROBAN_NETWORK_PASSPHRASE"
): void {
  const normalized = deploymentNetwork?.trim().toLowerCase();
  if (!isKnownNetworkName(normalized)) return;

  const expected = KNOWN_STELLAR_NETWORKS[normalized];
  if (passphrase !== expected) {
    throw new StellarNetworkConfigError(
      variable,
      `${variable} does not match STELLAR_NETWORK="${normalized}": ` +
        `expected the ${normalized} passphrase but got a different one. ` +
        `Mixing networks makes signatures, tx envelopes, and ledger reads ` +
        `target a chain the operator did not intend.`
    );
  }
}

function endpointNetwork(
  rawUrl: string,
  hosts: Readonly<Record<string, StellarNetworkName>>
): StellarNetworkName | "unknown" {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    // Malformed URLs are rejected by the URL validators, not here — a URL we
    // cannot parse simply yields no network verdict.
    return "unknown";
  }
  return hosts[hostname] ?? "unknown";
}

/**
 * Check that a Horizon endpoint serves the network the passphrase names
 * (#1134). Unknown hosts (self-hosted nodes, proxies) are skipped.
 */
export function assertHorizonMatchesNetwork(
  url: string,
  passphrase: string,
  variable = "STELLAR_HORIZON_URL"
): void {
  const expected = classifyNetworkPassphrase(passphrase);
  if (expected === "unknown") return;

  const actual = endpointNetwork(url, KNOWN_HORIZON_HOSTS);
  if (actual !== "unknown" && actual !== expected) {
    throw new StellarNetworkConfigError(
      variable,
      `${variable} points at the ${actual} network but ` +
        `SOROBAN_NETWORK_PASSPHRASE is the ${expected} passphrase. ` +
        `Reads would be served by the wrong chain.`
    );
  }
}

/**
 * Check that a Soroban RPC endpoint serves the network the passphrase names
 * (#1135). Unknown hosts (self-hosted nodes, proxies) are skipped.
 */
export function assertRpcMatchesNetwork(
  url: string,
  passphrase: string,
  variable = "STELLAR_RPC_URL"
): void {
  const expected = classifyNetworkPassphrase(passphrase);
  if (expected === "unknown") return;

  const actual = endpointNetwork(url, KNOWN_RPC_HOSTS);
  if (actual !== "unknown" && actual !== expected) {
    throw new StellarNetworkConfigError(
      variable,
      `${variable} points at the ${actual} network but ` +
        `SOROBAN_NETWORK_PASSPHRASE is the ${expected} passphrase. ` +
        `Submissions and ledger reads would target the wrong chain.`
    );
  }
}

/** Split a comma-separated endpoint list, dropping blanks. */
function splitUrls(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  return value
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * Run every network consistency invariant against a raw env map. Throws
 * {@link StellarNetworkConfigError} on the first violation.
 *
 * The `*_URLS` list variables are validated in full (not just their first
 * entry) because the transport layer fails over across every endpoint in the
 * list — a drifted secondary endpoint is just as dangerous as a drifted
 * primary one.
 *
 * `SOROBAN_NETWORK_PASSPHRASE` may be absent: services that do not touch the
 * chain (or that gate its presence themselves) still get their endpoint lists
 * checked against `STELLAR_NETWORK` when that names a known network.
 */
export function validateStellarNetworkConsistency(
  env: Env = process.env
): void {
  const passphrase = env["SOROBAN_NETWORK_PASSPHRASE"]?.trim();
  const deployment = env["STELLAR_NETWORK"]?.trim().toLowerCase();

  if (passphrase) {
    assertPassphraseMatchesDeployment(passphrase, deployment);
  }

  // Effective network for endpoint checks: the configured passphrase when
  // present, else the passphrase implied by a known STELLAR_NETWORK.
  const effectivePassphrase =
    passphrase ??
    (isKnownNetworkName(deployment)
      ? KNOWN_STELLAR_NETWORKS[deployment]
      : undefined);

  if (!effectivePassphrase) return;

  for (const url of splitUrls(env["STELLAR_HORIZON_URLS"])) {
    assertHorizonMatchesNetwork(
      url,
      effectivePassphrase,
      "STELLAR_HORIZON_URLS"
    );
  }
  const horizonUrl = env["STELLAR_HORIZON_URL"]?.trim();
  if (horizonUrl) {
    assertHorizonMatchesNetwork(horizonUrl, effectivePassphrase);
  }

  for (const url of splitUrls(env["STELLAR_RPC_URLS"])) {
    assertRpcMatchesNetwork(url, effectivePassphrase, "STELLAR_RPC_URLS");
  }
  const rpcUrl = env["STELLAR_RPC_URL"]?.trim();
  if (rpcUrl) {
    assertRpcMatchesNetwork(rpcUrl, effectivePassphrase);
  }
}
