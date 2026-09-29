/**
 * Domain separation for Ed25519 message signing (#978).
 *
 * Two independent signing paths in this codebase use the same Stellar
 * Ed25519 keypair primitive:
 *   - order receipts            (src/services/signing.ts)
 *   - oracle resolution reports (apps/oracle/signature-helper.ts)
 *
 * Both historically signed a bare `JSON.stringify(payload)` string. Because
 * the message layout carried no purpose tag and no network binding, a
 * signature produced for one purpose — or on one network (testnet) — is a
 * byte-for-byte valid signature for a matching message in another context
 * (mainnet, or the other signing path). That enables cross-domain and
 * cross-network replay of trades, resolutions, and admin actions.
 *
 * Every signed message MUST be wrapped with `buildDomainSeparatedMessage()`
 * so the domain tag and the Stellar network passphrase are covered by the
 * signature. Verifiers rebuild the same envelope, so a signature made under
 * a different domain or network no longer verifies.
 *
 * @module packages/shared/src/signingDomain
 */

import {
  isKnownStellarNetwork,
  normalizeStellarNetwork,
} from "./networkConsistency.js";

/**
 * Purpose tags. Each distinct signing use gets its own stable, versioned
 * string. Bump the version suffix if the enveloped payload shape changes in
 * a non-backward-compatible way.
 */
export const SIGNING_DOMAINS = {
  /** Off-chain order-receipt signatures (SigningService). */
  ORDER_RECEIPT: "vatix.order-receipt.v1",
  /** Oracle market-resolution report signatures. */
  ORACLE_RESOLUTION: "vatix.oracle-resolution.v1",
} as const;

export type SigningDomain =
  (typeof SIGNING_DOMAINS)[keyof typeof SIGNING_DOMAINS];

/**
 * Local-only stub passphrase used outside production so dev/test do not
 * need SOROBAN_NETWORK_PASSPHRASE set. Matches Stellar's public testnet
 * passphrase — it is not a secret.
 */
export const STUB_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * The network {@link STUB_NETWORK_PASSPHRASE} belongs to.
 *
 * Named separately from the passphrase value so `resolveSigningNetworkPassphrase()`
 * can ask "may this deployment use the stub?" without hard-coding a second
 * copy of the network id (#1133).
 */
export const STUB_NETWORK_PASSPHRASE_NETWORK = "testnet";

/** Thrown when the signing network binding is misconfigured. */
export class SigningDomainConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningDomainConfigError";
  }
}

/**
 * Resolve the Stellar network passphrase that binds a signature to exactly
 * one network.
 *
 * Production/dev split (no silent fallback in production):
 *   - NODE_ENV=production : SOROBAN_NETWORK_PASSPHRASE is mandatory. A
 *     missing/empty value throws — signing with the local stub would make
 *     testnet and mainnet signatures interchangeable.
 *   - otherwise           : falls back to STUB_NETWORK_PASSPHRASE.
 *
 * #1133 — the dev/test fallback is itself network-aware. `STUB_NETWORK_PASSPHRASE`
 * is the **testnet** passphrase, so falling back to it on a deployment that
 * declares `STELLAR_NETWORK=mainnet` would bind every order-receipt and
 * oracle-resolution signature to testnet while the rest of the stack talks to
 * mainnet: the signature would not match the chain it is replayed against, and
 * the binding the domain separation exists to provide is silently wrong. So
 * when the declared network is a known network *other* than testnet, an unset
 * passphrase throws in every environment — fail-closed, same rule, same class
 * of error. Only `testnet` (and custom networks, which have no published
 * passphrase to compare against) may use the stub.
 *
 * @param env - environment map (default: process.env), injectable for tests
 * @throws {SigningDomainConfigError} when the passphrase is unset and cannot be
 *   safely stubbed (production, or a declared non-testnet known network)
 */
export function resolveSigningNetworkPassphrase(
  env: Record<string, string | undefined> = process.env
): string {
  const configured = env.SOROBAN_NETWORK_PASSPHRASE?.trim();
  if (configured) return configured;

  if (env.NODE_ENV === "production") {
    throw new SigningDomainConfigError(
      "SOROBAN_NETWORK_PASSPHRASE is required in production for signing " +
        "domain separation. Refusing to sign with a local stub passphrase, " +
        "which would allow cross-network signature replay."
    );
  }

  // #1133 — the stub is the testnet passphrase, so it is only a valid
  // substitute for a deployment that is itself on testnet. A custom network
  // (futurenet, standalone) has no published passphrase, so it keeps the
  // historical dev/test behaviour.
  const declaredNetwork = normalizeStellarNetwork(env.STELLAR_NETWORK);
  if (
    isKnownStellarNetwork(declaredNetwork) &&
    declaredNetwork !== STUB_NETWORK_PASSPHRASE_NETWORK
  ) {
    throw new SigningDomainConfigError(
      `SOROBAN_NETWORK_PASSPHRASE is required when STELLAR_NETWORK="${declaredNetwork}" ` +
        "because the dev/test fallback passphrase is the testnet one. Signing " +
        `with it would bind every signature to testnet while the deployment ` +
        "operates on " +
        declaredNetwork +
        "."
    );
  }

  return STUB_NETWORK_PASSPHRASE;
}

/**
 * Wrap a caller's canonical payload in a domain- and network-separated
 * envelope. The returned string is the message that should be signed and
 * verified — never the bare payload.
 *
 * The envelope key order is fixed here, so callers only need their own
 * payload to be canonical (stable key order).
 */
export function buildDomainSeparatedMessage(
  domain: SigningDomain,
  networkPassphrase: string,
  payload: unknown
): string {
  return JSON.stringify({
    domain,
    network: networkPassphrase,
    payload,
  });
}
