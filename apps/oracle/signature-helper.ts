/**
 * Oracle Signature Helper
 *
 * Provides Ed25519 sign / verify helpers for oracle resolution reports.
 * Uses the Stellar Keypair primitive so the same key material works
 * with on-chain submission.
 *
 * @module apps/oracle/signature-helper
 */

import { Keypair } from "@stellar/stellar-sdk";
import {
  SIGNING_DOMAINS,
  buildDomainSeparatedMessage,
  resolveSigningNetworkPassphrase,
} from "../../packages/shared/src/signingDomain.js";

/**
 * The data payload that is signed for a resolution report.
 */
export interface ResolutionPayload {
  /** Market ID being resolved */
  marketId: string;
  /** Resolved outcome (true = YES, false = NO) */
  outcome: boolean;
  /** ISO timestamp of the resolution */
  timestamp: string;
}

/**
 * A resolution report with the oracle's signature and public key attached.
 */
export interface SignedResolutionReport {
  payload: ResolutionPayload;
  /** Base64-encoded Ed25519 signature */
  signature: string;
  /** Stellar-format public key of the signing keypair */
  publicKey: string;
  /**
   * Signature envelope version. `2` (current) binds the signature to both
   * the domain tag and the Stellar network passphrase (#978). `1` (legacy)
   * bound only the domain tag, which allowed a testnet signature to be
   * replayed as a valid mainnet signature and vice versa. Reports omitting
   * this field are treated as version `1` for backward compatibility with
   * signatures produced before #978.
   */
  version?: 1 | 2;
}

/** Current signature envelope version. Always used for newly signed reports. */
export const CURRENT_SIGNATURE_VERSION = 2 as const;

/**
 * Error thrown when a legacy (pre-#978), passphrase-less signature is
 * encountered in production. These signatures are vulnerable to
 * cross-network replay and must never be accepted as valid in production.
 */
export class LegacySignatureRejectedError extends Error {
  constructor(marketId: string) {
    super(
      `Legacy v1 signature (no network passphrase binding) rejected for market ${marketId} — cross-network replay risk. Re-sign with the current (v2) envelope.`
    );
    this.name = "LegacySignatureRejectedError";
  }
}

/**
 * Reproduces the pre-#978 canonical string: domain-separated but **not**
 * network-separated. Exists only so legacy reports can be recognized and,
 * outside production, verified during a migration window. Never used for
 * new signatures.
 */
function legacyCanonicalise(payload: ResolutionPayload): string {
  return JSON.stringify({
    domain: SIGNING_DOMAINS.ORACLE_RESOLUTION,
    payload: {
      marketId: payload.marketId,
      outcome: payload.outcome,
      timestamp: payload.timestamp,
    },
  });
}

/**
 * Produce a deterministic canonical string from a payload.
 *
 * The signed bytes are domain- and network-separated (#978): they embed the
 * `vatix.oracle-resolution.v1` domain tag and the active Stellar network
 * passphrase. This keeps an oracle-resolution signature from being replayed
 * as an order-receipt signature (a different domain tag) and a testnet
 * signature from verifying on mainnet (a different passphrase).
 *
 * Keys inside the payload are listed explicitly so the same data always
 * serialises identically.
 */
function canonicalise(
  payload: ResolutionPayload,
  networkPassphrase: string
): string {
  return buildDomainSeparatedMessage(
    SIGNING_DOMAINS.ORACLE_RESOLUTION,
    networkPassphrase,
    {
      marketId: payload.marketId,
      outcome: payload.outcome,
      timestamp: payload.timestamp,
    }
  );
}

/**
 * Sign a resolution payload with the given Stellar secret key.
 *
 * @param payload - Resolution data to sign
 * @param secretKey - Stellar secret key (S…)
 * @param networkPassphrase - Stellar network passphrase to bind the
 *   signature to. Defaults to `resolveSigningNetworkPassphrase()`, which
 *   requires SOROBAN_NETWORK_PASSPHRASE in production and falls back to the
 *   local stub otherwise.
 * @returns Signed report containing the payload, signature, and public key
 */
export function signResolutionReport(
  payload: ResolutionPayload,
  secretKey: string,
  networkPassphrase: string = resolveSigningNetworkPassphrase()
): SignedResolutionReport {
  const keypair = Keypair.fromSecret(secretKey);
  const message = Buffer.from(canonicalise(payload, networkPassphrase), "utf8");
  const signature = keypair.sign(message).toString("base64");

  return {
    payload,
    signature,
    publicKey: keypair.publicKey(),
    version: CURRENT_SIGNATURE_VERSION,
  };
}

/**
 * Verify a signed resolution report.
 *
 * Legacy (`version: 1` or missing `version`) reports are signatures that
 * predate #978's network-passphrase binding and are vulnerable to
 * cross-network replay (a testnet signature also verifies on mainnet). In
 * `NODE_ENV=production` these are rejected outright — `verifyResolutionReport`
 * throws `LegacySignatureRejectedError` rather than silently falling back to
 * the weaker legacy check. Outside production, legacy reports are still
 * verified (using the pre-#978 canonical form) so a migration window can
 * validate old signatures, but a warning is logged every time.
 *
 * @param report - The signed report to check
 * @param networkPassphrase - Passphrase the signature must be bound to.
 *   Defaults to `resolveSigningNetworkPassphrase()`.
 * @returns `true` when the signature is valid and the payload is unmodified
 * @throws {LegacySignatureRejectedError} If `report` is a legacy (v1)
 *   signature and `NODE_ENV=production`.
 */
export function verifyResolutionReport(
  report: SignedResolutionReport,
  networkPassphrase: string = resolveSigningNetworkPassphrase()
): boolean {
  const isLegacy = report.version === undefined || report.version === 1;

  if (isLegacy) {
    if (process.env.NODE_ENV === "production") {
      throw new LegacySignatureRejectedError(report.payload.marketId);
    }
    console.warn(
      "Verifying legacy v1 oracle signature (no network passphrase binding) — cross-network replay risk",
      { marketId: report.payload.marketId, event: "oracle.legacy_signature_verified" }
    );
    try {
      const message = Buffer.from(legacyCanonicalise(report.payload), "utf8");
      const signatureBuffer = Buffer.from(report.signature, "base64");
      const keypair = Keypair.fromPublicKey(report.publicKey);
      return keypair.verify(message, signatureBuffer);
    } catch {
      return false;
    }
  }

  try {
    const message = Buffer.from(
      canonicalise(report.payload, networkPassphrase),
      "utf8"
    );
    const signatureBuffer = Buffer.from(report.signature, "base64");
    const keypair = Keypair.fromPublicKey(report.publicKey);
    return keypair.verify(message, signatureBuffer);
  } catch {
    return false;
  }
}
