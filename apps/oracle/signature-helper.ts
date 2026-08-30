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

  return { payload, signature, publicKey: keypair.publicKey() };
}

/**
 * Verify a signed resolution report.
 *
 * @param report - The signed report to check
 * @param networkPassphrase - Passphrase the signature must be bound to.
 *   Defaults to `resolveSigningNetworkPassphrase()`.
 * @returns `true` when the signature is valid and the payload is unmodified
 */
export function verifyResolutionReport(
  report: SignedResolutionReport,
  networkPassphrase: string = resolveSigningNetworkPassphrase()
): boolean {
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
