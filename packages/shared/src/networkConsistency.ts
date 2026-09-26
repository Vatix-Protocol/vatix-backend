/**
 * Stellar network consistency gate (#1133, #1134, #1135).
 *
 * A Vatix deployment declares its target network three separate times:
 *
 *   - `SOROBAN_NETWORK_PASSPHRASE` — the passphrase mixed into every signed
 *     envelope and used to identify the network.
 *   - `STELLAR_NETWORK`            — the operator-facing network name.
 *   - `STELLAR_HORIZON_URL`/`S` and `STELLAR_RPC_URL`/`S` — the endpoints the
 *     services actually talk to.
 *
 * Historically those declarations were validated independently, so a
 * deployment could boot "successfully" while pointing at the wrong chain: a
 * testnet passphrase with a mainnet Horizon URL, or a mainnet RPC with a testnet
 * passphrase. The services then index, quote, or settle against a chain the
 * operator never intended — the failure class docs/env-validation.md calls out
 * under "Testnet vs mainnet".
 *
 * This module is the single place that knows how those declarations relate, so
 * every service (API, indexer, oracle, workers) enforces the same invariants
 * with the same stable error codes.
 *
 * Invariants:
 *   1. The configured passphrase must equal the passphrase published for
 *      `STELLAR_NETWORK`. Unknown/custom networks (futurenet, a standalone
 *      chain) are exempt — there is no known-good passphrase to compare.
 *   2. Every configured public Stellar endpoint (`*.stellar.org`) must belong
 *      to `STELLAR_NETWORK`, which catches testnet config pointing at mainnet
 *      Horizon/RPC and vice versa.
 *   3. Hosts outside `*.stellar.org` (third-party providers, self-hosted nodes)
 *      cannot be attributed to a network from the URL alone; they are accepted
 *      and warned about in production rather than rejected.
 *   4. Failures are fail-closed and carry only the variable *name* and a stable
 *      error code — never the value, and never a secret.
 *
 * @module packages/shared/src/networkConsistency
 */

/**
 * Stable error code for a network declaration that disagrees with the declared
 * network. Documented in docs/env-validation.md alongside ENV_MISSING and
 * ENV_INVALID so operators and tests can match on the code, not the message.
 */
export const ENV_NETWORK_MISMATCH = "ENV_NETWORK_MISMATCH";

/** Endpoint families that must agree with the declared network. */
export type StellarEndpointKind = "horizon" | "rpc";

/**
 * Known Stellar network passphrases, keyed by the deployment identifier used
 * in `STELLAR_NETWORK`. This is the canonical list: apps/indexer/src/config.ts
 * and apps/workers/src/oracle/stellar-config.ts re-export it so contributors
 * only have to update it here.
 */
export const KNOWN_NETWORK_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
} as const;

export type KnownStellarNetwork = keyof typeof KNOWN_NETWORK_PASSPHRASES;

/**
 * Public Stellar endpoints, per network and endpoint kind. A `*.stellar.org`
 * host that is not listed for the declared network is treated as drift.
 *
 * `soroban.stellar.org` is accepted for mainnet because it is the mainnet RPC
 * documented in `.env.example`; it is an alias of `soroban-mainnet.stellar.org`.
 */
export const KNOWN_NETWORK_ENDPOINTS: Record<
  KnownStellarNetwork,
  Record<StellarEndpointKind, readonly string[]>
> = {
  testnet: {
    horizon: ["horizon-testnet.stellar.org"],
    rpc: ["soroban-testnet.stellar.org"],
  },
  mainnet: {
    horizon: ["horizon.stellar.org"],
    rpc: ["soroban-mainnet.stellar.org", "soroban.stellar.org"],
  },
};

/** Suffix identifying a first-party Stellar-operated host. */
const STELLAR_HOST_SUFFIX = ".stellar.org";

/** Env map accepted by every helper — compatible with process.env and test objects. */
export type NetworkEnv = Record<string, string | undefined>;

/**
 * Hostnames that are always a local/standalone node rather than a public
 * network endpoint.
 */
function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    // Bare IPv4/IPv6 literals, e.g. a private Soroban node in docker-compose.
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    hostname.includes(":")
  );
}

/**
 * Fail-closed network consistency error. Carries the stable
 * {@link ENV_NETWORK_MISMATCH} code and the offending variable *name* only, so
 * it is safe to log verbatim — no passphrase, URL, or credential is embedded.
 */
export class StellarNetworkConsistencyError extends Error {
  readonly code = ENV_NETWORK_MISMATCH;
  /** Name of the offending environment variable (never its value). */
  readonly variable: string;
  readonly statusCode = 400;

  constructor(variable: string, message: string) {
    // The stable code leads the message so log lines and test assertions can
    // match on it without a second lookup, matching the
    // `[env] ENV_NETWORK_MISMATCH: STELLAR_HORIZON_URL` shape documented in
    // docs/env-validation.md.
    super(`${ENV_NETWORK_MISMATCH}: ${message}`);
    this.name = "StellarNetworkConsistencyError";
    this.variable = variable;
  }
}

/**
 * Normalizes a `STELLAR_NETWORK` value (trimmed, lowercased) and defaults to
 * `testnet` when unset, matching the documented default in `.env.example`.
 */
export function normalizeStellarNetwork(network?: string): string {
  const trimmed = network?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.toLowerCase() : "testnet";
}

/** Returns the known passphrase for a network id, or undefined for custom networks. */
export function knownPassphraseForNetwork(network: string): string | undefined {
  return (KNOWN_NETWORK_PASSPHRASES as Record<string, string | undefined>)[
    normalizeStellarNetwork(network)
  ];
}

/** True when we know the published passphrase and endpoints for a network id. */
export function isKnownStellarNetwork(network: string): boolean {
  return normalizeStellarNetwork(network) in KNOWN_NETWORK_PASSPHRASES;
}

/**
 * Resolves the lowercased hostname of an endpoint URL, or undefined when the
 * URL is unparseable / has no hostname. Returns undefined rather than throwing
 * so callers can decide the right error for their own variable.
 */
export function endpointHostname(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (!parsed.hostname) return undefined;
  // `new URL` keeps IPv6 brackets; strip them and any trailing dot so
  // "horizon.stellar.org." cannot bypass the allowlist.
  return parsed.hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
}

/**
 * #1133 — the configured network passphrase must match the declared network.
 *
 * Throws {@link StellarNetworkConsistencyError} when `STELLAR_NETWORK` names a
 * network we know and the passphrase differs. Custom networks are skipped
 * because there is no published passphrase to compare against.
 */
export function assertNetworkPassphraseMatches(
  passphrase: string,
  network: string,
  variable = "SOROBAN_NETWORK_PASSPHRASE"
): void {
  const normalized = normalizeStellarNetwork(network);
  const expected = knownPassphraseForNetwork(normalized);

  if (!expected || expected === passphrase) return;

  throw new StellarNetworkConsistencyError(
    variable,
    `SOROBAN_NETWORK_PASSPHRASE does not match STELLAR_NETWORK="${normalized}": ` +
      `expected the published ${normalized} passphrase but got a different value. ` +
      `A passphrase/network mismatch makes signatures, indexer cursors, and ` +
      `settlement state belong to a chain this deployment is not pointed at.`
  );
}

/**
 * #1134 / #1135 — a configured public Stellar endpoint must serve the declared
 * network.
 *
 * Throws {@link StellarNetworkConsistencyError} when a `*.stellar.org` host is
 * not published for `network`. Local and third-party hosts cannot be attributed
 * from the URL, so they pass this check and are surfaced by
 * {@link collectUnverifiableEndpointWarnings} instead.
 */
export function assertEndpointMatchesNetwork(
  url: string,
  network: string,
  kind: StellarEndpointKind,
  variable: string
): void {
  const normalized = normalizeStellarNetwork(network);
  const allowed = (
    KNOWN_NETWORK_ENDPOINTS as Record<
      string,
      Record<StellarEndpointKind, readonly string[]>
    >
  )[normalized];

  // Custom networks have no published endpoint list to check against.
  if (!allowed) return;

  const hostname = endpointHostname(url);

  // A local/standalone node is legitimately any network; skip it. An
  // unparseable URL is left to the caller's own URL validation.
  if (!hostname || isLocalHost(hostname)) return;

  if (!hostname.endsWith(STELLAR_HOST_SUFFIX)) return;

  if (allowed[kind].includes(hostname)) return;

  throw new StellarNetworkConsistencyError(
    variable,
    `${variable} host "${hostname}" is not a known ${kind} endpoint for ` +
      `STELLAR_NETWORK="${normalized}". Known ${kind} hosts for ${normalized}: ` +
      `${allowed[kind].join(", ")}. Point ${variable} at a ${normalized} endpoint, ` +
      `or set STELLAR_NETWORK to the network the endpoint actually serves.`
  );
}

/** Configured endpoint variables paired with the family they belong to. */
const ENDPOINT_VARIABLES: ReadonlyArray<
  readonly [string, StellarEndpointKind]
> = [
  ["STELLAR_HORIZON_URL", "horizon"],
  ["STELLAR_HORIZON_URLS", "horizon"],
  ["STELLAR_RPC_URL", "rpc"],
  ["STELLAR_RPC_URLS", "rpc"],
];

/** Splits a single-URL or comma-separated endpoint variable into candidates. */
function endpointCandidates(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * Returns a warning per configured endpoint whose network cannot be verified
 * from its URL. Purely advisory — never throws — so callers can decide whether
 * the deployment environment warrants the noise (production only).
 */
export function collectUnverifiableEndpointWarnings(
  env: NetworkEnv,
  network?: string
): string[] {
  const normalized = normalizeStellarNetwork(network);
  // For a custom network we have no endpoint list to compare against at all.
  if (!isKnownStellarNetwork(normalized)) return [];

  const allowed = KNOWN_NETWORK_ENDPOINTS[normalized as KnownStellarNetwork];
  const warnings: string[] = [];

  for (const [variable, kind] of ENDPOINT_VARIABLES) {
    for (const candidate of endpointCandidates(env[variable])) {
      const hostname = endpointHostname(candidate);
      if (!hostname || isLocalHost(hostname)) continue;
      if (hostname.endsWith(STELLAR_HOST_SUFFIX)) continue;
      if (allowed[kind].includes(hostname)) continue;

      warnings.push(
        `${variable} host "${hostname}" is not a first-party Stellar endpoint, ` +
          `so its network cannot be verified against STELLAR_NETWORK="${normalized}"`
      );
    }
  }

  return warnings;
}

/**
 * Emits one `[env] WARNING` line per Stellar endpoint whose network cannot be
 * verified from its URL. Production only — dev/test setups legitimately point
 * at local stand-ins. Advisory, never fatal: a third-party provider is a valid
 * deployment choice, it just cannot be checked by host name.
 */
export function warnUnverifiableStellarEndpoints(
  env: NetworkEnv,
  nodeEnv?: string
): string[] {
  const warnings = collectUnverifiableEndpointWarnings(
    env,
    env.STELLAR_NETWORK
  );

  if (nodeEnv === "production") {
    for (const warning of warnings) {
      console.warn(`[env] WARNING: ${warning}`);
    }
  }

  return warnings;
}

/**
 * The boot gate every Vatix service calls: asserts the passphrase (#1133) and
 * every configured Horizon/RPC endpoint (#1134, #1135) agree with
 * `STELLAR_NETWORK`.
 *
 * Fail-closed: on any disagreement the caller must abort startup. Only
 * variables that are actually set are checked, so this composes with each
 * service's own "is this variable required?" logic.
 *
 * @param env - Defaults to process.env. Pass a plain object in tests.
 */
export function assertStellarNetworkConsistency(
  env: NetworkEnv = process.env as NetworkEnv
): void {
  const network = normalizeStellarNetwork(env.STELLAR_NETWORK);
  const passphrase = env.SOROBAN_NETWORK_PASSPHRASE?.trim();

  if (passphrase) {
    assertNetworkPassphraseMatches(passphrase, network);
  }

  for (const [variable, kind] of ENDPOINT_VARIABLES) {
    for (const candidate of endpointCandidates(env[variable])) {
      assertEndpointMatchesNetwork(candidate, network, kind, variable);
    }
  }
}
