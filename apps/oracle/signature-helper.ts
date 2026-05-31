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
 * Keys are sorted so the same data always serialises identically.
 */
function canonicalise(payload: ResolutionPayload): string {
  return JSON.stringify({
    marketId: payload.marketId,
    outcome: payload.outcome,
    timestamp: payload.timestamp,
  });
}

/**
 * Sign a resolution payload with the given Stellar secret key.
 *
 * @param payload - Resolution data to sign
 * @param secretKey - Stellar secret key (S…)
 * @returns Signed report containing the payload, signature, and public key
 */
export function signResolutionReport(
  payload: ResolutionPayload,
  secretKey: string
): SignedResolutionReport {
  const keypair = Keypair.fromSecret(secretKey);
  const message = Buffer.from(canonicalise(payload), "utf8");
  const signature = keypair.sign(message).toString("base64");

  return { payload, signature, publicKey: keypair.publicKey() };
}

/**
 * Verify a signed resolution report.
 *
 * @param report - The signed report to check
 * @returns `true` when the signature is valid and the payload is unmodified
 */
export function verifyResolutionReport(report: SignedResolutionReport): boolean {
  try {
    const message = Buffer.from(canonicalise(report.payload), "utf8");
    const signatureBuffer = Buffer.from(report.signature, "base64");
    const keypair = Keypair.fromPublicKey(report.publicKey);
    return keypair.verify(message, signatureBuffer);
  } catch {
    return false;
  }
}
