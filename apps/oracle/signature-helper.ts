/**
 * Oracle Signature Helper
 *
 * Provides Ed25519 sign / verify helpers for oracle resolution reports.
 * Uses the Stellar Keypair primitive so the same key material works
 * with on-chain submission.
 *
 * Invariants (#1113):
 *   1. Signed bytes are domain- and network-separated (#978): an oracle
 *      signature cannot be replayed as an order receipt, nor across networks.
 *   2. A payload is validated before any key is touched — an invalid payload
 *      is never signed (`ORACLE_SIGNATURE_INVALID_PAYLOAD`).
 *   3. Verification requires a *pinned* trusted signer
 *      (`ORACLE_SIGNER_PUBLIC_KEY` or an explicit `expectedPublicKey`).
 *      In production an unpinned signer fails closed rather than trusting the
 *      report's self-declared `publicKey`.
 *   4. Legacy (pre-#978) envelopes are rejected outright in production.
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
 * Stable, machine-readable error codes for the oracle signature helper
 * (#1113). Callers (workers, routes, dashboards) branch on `code`; messages
 * are never parsed.
 */
export const ORACLE_SIGNATURE_ERROR_CODES = {
  /** The resolution payload is structurally invalid — never signed. */
  ORACLE_SIGNATURE_INVALID_PAYLOAD: "ORACLE_SIGNATURE_INVALID_PAYLOAD",
  /** `ORACLE_SIGNER_PUBLIC_KEY` is set but is not a Stellar account id. */
  ORACLE_SIGNATURE_INVALID_TRUSTED_SIGNER:
    "ORACLE_SIGNATURE_INVALID_TRUSTED_SIGNER",
  /** The report was signed by a key that is not the pinned trusted signer. */
  ORACLE_SIGNATURE_UNTRUSTED_SIGNER: "ORACLE_SIGNATURE_UNTRUSTED_SIGNER",
  /**
   * Verification is fail-closed and no trusted signer is pinned, so the
   * report's self-declared `publicKey` cannot be trusted. Production refuses
   * to verify at all rather than accepting an attacker-signed report.
   */
  ORACLE_SIGNATURE_TRUSTED_SIGNER_REQUIRED:
    "ORACLE_SIGNATURE_TRUSTED_SIGNER_REQUIRED",
  /** A legacy (pre-#978) passphrase-less signature was rejected. */
  ORACLE_SIGNATURE_LEGACY_REJECTED: "ORACLE_SIGNATURE_LEGACY_REJECTED",
} as const;

export type OracleSignatureErrorCode =
  (typeof ORACLE_SIGNATURE_ERROR_CODES)[keyof typeof ORACLE_SIGNATURE_ERROR_CODES];

/** Correlation id for one signature operation (#1113) — never a secret. */
function newSignatureCorrelationId(): string {
  return `osig_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Typed operational error for the oracle signature helper. Carries a stable
 * `code` plus a `correlationId` so a rejection can be stitched to logs and
 * metrics. Never embeds key material — only the offending market id.
 */
export class OracleSignatureError extends Error {
  readonly code: OracleSignatureErrorCode;
  readonly correlationId: string;
  readonly marketId?: string;

  constructor(
    code: OracleSignatureErrorCode,
    message: string,
    options: { marketId?: string; correlationId?: string } = {}
  ) {
    super(message);
    this.name = "OracleSignatureError";
    this.code = code;
    this.correlationId = options.correlationId ?? newSignatureCorrelationId();
    this.marketId = options.marketId;
  }
}

/** Maximum accepted length of a market id (adversarial-input bound). */
export const MAX_MARKET_ID_LENGTH = 128;

/** Stellar strkey encodings used for the oracle signer. */
const STELLAR_PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;
const STELLAR_SECRET_KEY_PATTERN = /^S[A-Z2-7]{55}$/;

/**
 * Error thrown when a legacy (pre-#978), passphrase-less signature is
 * encountered in production. These signatures are vulnerable to
 * cross-network replay and must never be accepted as valid in production.
 */
export class LegacySignatureRejectedError extends Error {
  readonly code = ORACLE_SIGNATURE_ERROR_CODES.ORACLE_SIGNATURE_LEGACY_REJECTED;
  readonly correlationId: string;
  readonly marketId: string;

  constructor(marketId: string) {
    super(
      `Legacy v1 signature (no network passphrase binding) rejected for market ${marketId} — cross-network replay risk. Re-sign with the current (v2) envelope.`
    );
    this.name = "LegacySignatureRejectedError";
    this.marketId = marketId;
    this.correlationId = newSignatureCorrelationId();
  }
}

/**
 * Fail-closed validation of a resolution payload (#1113).
 *
 * Signing a payload with an empty market id, a non-boolean outcome, or an
 * unparseable timestamp produces a report that is syntactically valid but
 * meaningless on-chain (and can collide with a different market's canonical
 * bytes), so it is rejected before any key material is touched.
 *
 * @throws {OracleSignatureError} with `ORACLE_SIGNATURE_INVALID_PAYLOAD`.
 */
export function assertValidResolutionPayload(payload: ResolutionPayload): void {
  if (!payload || typeof payload !== "object") {
    throw new OracleSignatureError(
      ORACLE_SIGNATURE_ERROR_CODES.ORACLE_SIGNATURE_INVALID_PAYLOAD,
      "Resolution payload must be an object"
    );
  }

  if (
    typeof payload.marketId !== "string" ||
    payload.marketId.length === 0 ||
    payload.marketId.length > MAX_MARKET_ID_LENGTH
  ) {
    throw new OracleSignatureError(
      ORACLE_SIGNATURE_ERROR_CODES.ORACLE_SIGNATURE_INVALID_PAYLOAD,
      `Resolution payload marketId must be a non-empty string of at most ${MAX_MARKET_ID_LENGTH} characters`
    );
  }

  if (typeof payload.outcome !== "boolean") {
    throw new OracleSignatureError(
      ORACLE_SIGNATURE_ERROR_CODES.ORACLE_SIGNATURE_INVALID_PAYLOAD,
      `Resolution payload outcome must be a boolean for market ${payload.marketId}`,
      { marketId: payload.marketId }
    );
  }

  if (
    typeof payload.timestamp !== "string" ||
    payload.timestamp.length === 0 ||
    !Number.isFinite(Date.parse(payload.timestamp))
  ) {
    throw new OracleSignatureError(
      ORACLE_SIGNATURE_ERROR_CODES.ORACLE_SIGNATURE_INVALID_PAYLOAD,
      `Resolution payload timestamp must be an ISO-8601 date string for market ${payload.marketId}`,
      { marketId: payload.marketId }
    );
  }
}

/** True when `value` is a Stellar account id (strkey `G…`). */
export function isStellarPublicKey(value: unknown): value is string {
  return typeof value === "string" && STELLAR_PUBLIC_KEY_PATTERN.test(value);
}

/** True when `value` is a Stellar secret key (strkey `S…`). */
export function isStellarSecretKey(value: unknown): value is string {
  return typeof value === "string" && STELLAR_SECRET_KEY_PATTERN.test(value);
}

/**
 * Resolve the pinned oracle signer public key from the environment (#1113).
 *
 * `ORACLE_SIGNER_PUBLIC_KEY` is the trust anchor: a resolution report carries
 * its own `publicKey`, so without a pinned key any party can self-sign a
 * report that "verifies". Unset resolves to `undefined` — the caller then
 * decides whether that is fatal (see `verifyResolutionReport`).
 *
 * @throws {OracleSignatureError} `ORACLE_SIGNATURE_INVALID_TRUSTED_SIGNER`
 *   when the variable is set to something that is not a Stellar account id,
 *   so a typo can never silently disable signer pinning.
 */
export function resolveTrustedSignerPublicKey(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const configured = env.ORACLE_SIGNER_PUBLIC_KEY?.trim();
  if (!configured) {
    return undefined;
  }

  if (!isStellarPublicKey(configured)) {
    throw new OracleSignatureError(
      ORACLE_SIGNATURE_ERROR_CODES.ORACLE_SIGNATURE_INVALID_TRUSTED_SIGNER,
      "ORACLE_SIGNER_PUBLIC_KEY must be a Stellar account id (G...)"
    );
  }

  return configured;
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
 * @throws {OracleSignatureError} `ORACLE_SIGNATURE_INVALID_PAYLOAD` when the
 *   payload is structurally invalid — nothing is signed in that case.
 */
export function signResolutionReport(
  payload: ResolutionPayload,
  secretKey: string,
  networkPassphrase: string = resolveSigningNetworkPassphrase()
): SignedResolutionReport {
  assertValidResolutionPayload(payload);

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
 * Trusted-signer policy for `verifyResolutionReport` (#1113).
 */
export interface VerifyResolutionOptions {
  /**
   * Pinned trusted signer public key. Defaults to `ORACLE_SIGNER_PUBLIC_KEY`
   * from `env`. A report signed by any other key never verifies.
   */
  expectedPublicKey?: string;
  /**
   * Fail closed when no trusted signer can be resolved. Defaults to
   * `NODE_ENV=production`. When true and no trusted signer is configured,
   * verification throws instead of trusting the report's own public key.
   */
  requireTrustedSigner?: boolean;
  /** Environment map used for the defaults above (injectable for tests). */
  env?: Record<string, string | undefined>;
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
 * ## Trusted signer pinning (#1113)
 *
 * A report carries its own `publicKey`, so a bare signature check only proves
 * "some key signed this" — an attacker can self-sign a report for any market
 * and it would verify. The trust anchor is therefore an explicitly pinned
 * signer: `options.expectedPublicKey`, else `ORACLE_SIGNER_PUBLIC_KEY`.
 *
 * - Pinned signer configured and the report was signed by another key →
 *   returns `false` (an untrusted signer never verifies, in any environment).
 * - No pinned signer and `requireTrustedSigner` (default: `NODE_ENV=production`,
 *   or `true` when passed explicitly) → throws
 *   `ORACLE_SIGNATURE_TRUSTED_SIGNER_REQUIRED`. Fail-closed / deny-by-default:
 *   production refuses to verify an unpinned report rather than trusting the
 *   report's self-declared key.
 * - No pinned signer outside production → verifies as before (self-declared
 *   key), with a warning, so local/test flows keep working.
 *
 * @param report - The signed report to check
 * @param networkPassphrase - Passphrase the signature must be bound to.
 *   Defaults to `resolveSigningNetworkPassphrase()`.
 * @param options - Trusted-signer policy. See above.
 * @returns `true` when the signature is valid, the payload is unmodified, and
 *   the signer is trusted.
 * @throws {LegacySignatureRejectedError} If `report` is a legacy (v1)
 *   signature and `NODE_ENV=production`.
 * @throws {OracleSignatureError} `ORACLE_SIGNATURE_TRUSTED_SIGNER_REQUIRED`
 *   when signer pinning is required but no trusted signer is configured, and
 *   `ORACLE_SIGNATURE_INVALID_TRUSTED_SIGNER` when the configured trusted
 *   signer is not a Stellar account id.
 */
export function verifyResolutionReport(
  report: SignedResolutionReport,
  networkPassphrase: string = resolveSigningNetworkPassphrase(),
  options: VerifyResolutionOptions = {}
): boolean {
  if (!report || typeof report !== "object" || !report.payload) {
    return false;
  }

  // Legacy envelope check runs first: a pre-#978 report is rejected on its
  // own merits in production, independent of the signer policy below.
  const { expectedPublicKey, env = process.env } = options;
  const isLegacy = report.version === undefined || report.version === 1;
  if (isLegacy && env.NODE_ENV === "production") {
    throw new LegacySignatureRejectedError(report.payload.marketId);
  }
  const trustedSigner = expectedPublicKey ?? resolveTrustedSignerPublicKey(env);
  const requireTrustedSigner =
    options.requireTrustedSigner ?? env.NODE_ENV === "production";

  if (trustedSigner && report.publicKey !== trustedSigner) {
    console.warn(
      "Rejecting oracle resolution report from an untrusted signer",
      {
        event: "oracle.untrusted_signature_signer",
        marketId: report.payload?.marketId,
        code: ORACLE_SIGNATURE_ERROR_CODES.ORACLE_SIGNATURE_UNTRUSTED_SIGNER,
      }
    );
    return false;
  }

  if (!trustedSigner && requireTrustedSigner) {
    throw new OracleSignatureError(
      ORACLE_SIGNATURE_ERROR_CODES.ORACLE_SIGNATURE_TRUSTED_SIGNER_REQUIRED,
      "Refusing to verify an oracle resolution report without a pinned trusted signer. Set ORACLE_SIGNER_PUBLIC_KEY (or pass expectedPublicKey) to the oracle signer's Stellar account id.",
      { marketId: report.payload?.marketId }
    );
  }

  if (!trustedSigner) {
    console.warn(
      "Verifying oracle resolution report without a pinned trusted signer — any keypair can self-sign this report",
      {
        marketId: report.payload?.marketId,
        event: "oracle.unpinned_signature_signer",
        code: ORACLE_SIGNATURE_ERROR_CODES.ORACLE_SIGNATURE_TRUSTED_SIGNER_REQUIRED,
      }
    );
  }

  if (isLegacy) {
    // Non-production only: the production rejection already happened above.
    console.warn(
      "Verifying legacy v1 oracle signature (no network passphrase binding) — cross-network replay risk",
      {
        marketId: report.payload.marketId,
        event: "oracle.legacy_signature_verified",
      }
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
