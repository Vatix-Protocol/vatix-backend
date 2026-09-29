/**
 * Oracle Config Loader
 *
 * Reads and validates all oracle environment variables in one place,
 * returning a strongly-typed OracleConfig object.
 *
 * @module apps/oracle/oracle-config
 */

import {
  getOraclePollIntervalMs,
  DEFAULT_POLL_INTERVAL_MS,
} from "./oracle-scheduler.js";
import { DEFAULT_TIMEOUT_MS } from "./timeout-utils.js";
import { Keypair } from "@stellar/stellar-sdk";
import { isStellarPublicKey, isStellarSecretKey } from "./signature-helper.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Stable, machine-readable error codes for oracle configuration (#1115).
 * Operators and dashboards branch on `code`; messages are never parsed.
 */
export const ORACLE_CONFIG_ERROR_CODES = {
  /** A variable is present but not parseable / out of range. */
  ORACLE_CONFIG_INVALID_VALUE: "ORACLE_CONFIG_INVALID_VALUE",
  /** A required variable is missing in the current environment. */
  ORACLE_CONFIG_MISSING_REQUIRED: "ORACLE_CONFIG_MISSING_REQUIRED",
  /**
   * `ORACLE_SIGNER_PUBLIC_KEY` does not match the public key derived from
   * `ORACLE_SECRET_KEY` — the signer identity drifted (wrong key or the wrong
   * network's keypair was loaded).
   */
  ORACLE_CONFIG_SIGNER_MISMATCH: "ORACLE_CONFIG_SIGNER_MISMATCH",
  /**
   * A secret-bearing variable (e.g. `ORACLE_SECRET_KEY`) is present but does
   * not look like a Stellar secret key. Fail closed rather than sign with an
   * unvalidated value (#1180).
   */
  ORACLE_CONFIG_INVALID_SECRET: "ORACLE_CONFIG_INVALID_SECRET",
  /**
   * A secret-bearing variable is required for the current environment but was
   * not provided. Deny-by-default: privileged signing surfaces never start
   * without an explicit key (#1180).
   */
  ORACLE_CONFIG_MISSING_SECRET: "ORACLE_CONFIG_MISSING_SECRET",
} as const;

export type OracleConfigErrorCode =
  (typeof ORACLE_CONFIG_ERROR_CODES)[keyof typeof ORACLE_CONFIG_ERROR_CODES];

/** Correlation id for one config load (#1115) — safe to log. */
function newConfigCorrelationId(): string {
  return `ocfg_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Typed configuration error. Always carries a stable `code` and a
 * `correlationId`. The offending *value* is never embedded (it may be key
 * material); only the variable name.
 */
export class OracleConfigError extends Error {
  readonly code: OracleConfigErrorCode;
  readonly correlationId: string;
  readonly variable: string;

  constructor(
    code: OracleConfigErrorCode,
    variable: string,
    message: string,
    correlationId = newConfigCorrelationId()
  ) {
    super(message);
    this.name = "OracleConfigError";
    this.code = code;
    this.variable = variable;
    this.correlationId = correlationId;
  }
}

/**
 * Fully resolved oracle configuration derived from environment variables.
 * All fields have concrete types — no `any`.
 */
export interface OracleConfig {
  /** Polling interval for oracle resolution checks, in milliseconds. */
  pollIntervalMs: number;
  /** Duration of the oracle challenge window, in seconds. */
  challengeWindowSeconds: number;
  /** Log verbosity for the oracle scheduler. */
  logLevel: LogLevel;
  /**
   * Stellar secret key used to sign resolution reports.
   * Present only when `ORACLE_SECRET_KEY` is set in the environment.
   *
   * Never log this value — use {@link describeOracleConfig} for logging.
   */
  secretKey: string | undefined;
  /**
   * Public key derived from `secretKey` (never secret). `undefined` when no
   * secret is configured. Exposed so operators can confirm *which* signer a
   * deployment is signing with without exposing the key.
   */
  signerPublicKey: string | undefined;
  /**
   * Pinned trusted signer for verification (#1113), from
   * `ORACLE_SIGNER_PUBLIC_KEY`. When both this and `signerPublicKey` are
   * present they must be equal, otherwise startup fails closed with
   * `ORACLE_CONFIG_SIGNER_MISMATCH` (catches testnet/mainnet address drift).
   */
  trustedSignerPublicKey: string | undefined;
  /** Timeout for the primary oracle provider, in milliseconds. */
  primaryTimeoutMs: number;
  /** Timeout for the fallback oracle provider, in milliseconds. */
  fallbackTimeoutMs: number;
  /**
   * Minimum acceptable confidence score (0-1, inclusive) for a resolution
   * to be enqueued for on-chain submission. Results below this threshold
   * are treated as a fail-closed condition: they are never enqueued, and
   * in production they raise the same `oracleFailClosedTotal` metric used
   * for total provider outages.
   */
  minConfidenceThreshold: number;
}

const VALID_LOG_LEVELS: ReadonlySet<string> = new Set([
  "debug",
  "info",
  "warn",
  "error",
]);

const DEFAULT_CHALLENGE_WINDOW_SECONDS = 86_400;
const DEFAULT_LOG_LEVEL: LogLevel = "info";
/**
 * Default minimum confidence threshold. Chosen to be strict enough that a
 * partial-success, low-confidence resolution never reaches the submission
 * queue silently — operators must explicitly lower this via
 * `ORACLE_MIN_CONFIDENCE_THRESHOLD` if they want to accept weaker signals.
 */
const DEFAULT_MIN_CONFIDENCE_THRESHOLD = 0.75;

/**
 * Upper bounds that catch unit mix-ups (e.g. `ORACLE_CHALLENGE_WINDOW_SECONDS`
 * set to milliseconds, or a provider timeout set to hours). Without them a
 * typo silently widens the challenge window or makes every poll hang.
 */
export const MAX_CHALLENGE_WINDOW_SECONDS = 30 * 86_400; // 30 days
export const MAX_PROVIDER_TIMEOUT_MS = 120_000; // 2 minutes

type Env = Record<string, string | undefined>;

/**
 * Ops-safe description of a loaded config. Contains no key material: the
 * secret is reduced to a boolean and only the derived (public) signer key is
 * reported. Safe to log at startup (#1115).
 */
export interface OracleConfigSummary {
  pollIntervalMs: number;
  challengeWindowSeconds: number;
  logLevel: LogLevel;
  primaryTimeoutMs: number;
  fallbackTimeoutMs: number;
  minConfidenceThreshold: number;
  /** Whether a signing key is configured — never the key itself. */
  secretKeyConfigured: boolean;
  /** Public key derived from the signing key, when present. */
  signerPublicKey?: string;
  /** Pinned trusted signer for verification, when present. */
  trustedSignerPublicKey?: string;
}

/**
 * Project a config into a loggable summary with no secrets (#1115).
 * @see OracleConfig.secretKey
 */
export function describeOracleConfig(
  config: OracleConfig
): OracleConfigSummary {
  return {
    pollIntervalMs: config.pollIntervalMs,
    challengeWindowSeconds: config.challengeWindowSeconds,
    logLevel: config.logLevel,
    primaryTimeoutMs: config.primaryTimeoutMs,
    fallbackTimeoutMs: config.fallbackTimeoutMs,
    minConfidenceThreshold: config.minConfidenceThreshold,
    secretKeyConfigured: config.secretKey !== undefined,
    ...(config.signerPublicKey
      ? { signerPublicKey: config.signerPublicKey }
      : {}),
    ...(config.trustedSignerPublicKey
      ? { trustedSignerPublicKey: config.trustedSignerPublicKey }
      : {}),
  };
}

/**
 * Read and validate oracle environment variables.
 *
 * Fail-closed rules (#1115, #1180):
 *   - Any *present* variable that cannot be parsed, or that falls outside its
 *     bounds, throws `OracleConfigError` — a broken value is never silently
 *     replaced by a default.
 *   - `ORACLE_SECRET_KEY`, when set, must be a Stellar secret key (`S…`).
 *   - `ORACLE_SIGNER_PUBLIC_KEY`, when set, must be a Stellar account id
 *     (`G…`) and must equal the public key derived from `ORACLE_SECRET_KEY`
 *     (`ORACLE_CONFIG_SIGNER_MISMATCH`) — this is what catches a deployment
 *     that loaded the wrong network's keypair.
 *   - When `ORACLE_REQUIRE_SECRET_KEY` is truthy (production / mainnet),
 *     `ORACLE_SECRET_KEY` is mandatory: a missing key fails closed with
 *     `ORACLE_CONFIG_MISSING_SECRET` instead of starting an unsigned oracle.
 *
 * @param env - Environment map (defaults to `process.env`).
 * @returns Validated OracleConfig.
 * @throws {OracleConfigError} When any present variable fails validation.
 */
export function loadOracleConfig(env: Env = process.env): OracleConfig {
  const correlationId = newConfigCorrelationId();
  const pollIntervalMs = getOraclePollIntervalMs();

  const challengeWindowSeconds = parseBoundedInt(
    env["ORACLE_CHALLENGE_WINDOW_SECONDS"],
    "ORACLE_CHALLENGE_WINDOW_SECONDS",
    DEFAULT_CHALLENGE_WINDOW_SECONDS,
    MAX_CHALLENGE_WINDOW_SECONDS,
    correlationId
  );

  const logLevel = parseLogLevel(env["ORACLE_LOG_LEVEL"], "ORACLE_LOG_LEVEL");

  const primaryTimeoutMs = parseBoundedInt(
    env["ORACLE_PRIMARY_TIMEOUT_MS"],
    "ORACLE_PRIMARY_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
    MAX_PROVIDER_TIMEOUT_MS,
    correlationId
  );

  const fallbackTimeoutMs = parseBoundedInt(
    env["ORACLE_FALLBACK_TIMEOUT_MS"],
    "ORACLE_FALLBACK_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
    MAX_PROVIDER_TIMEOUT_MS,
    correlationId
  );

  const minConfidenceThreshold = parseBoundedFloat(
    env["ORACLE_MIN_CONFIDENCE_THRESHOLD"],
    "ORACLE_MIN_CONFIDENCE_THRESHOLD",
    DEFAULT_MIN_CONFIDENCE_THRESHOLD,
    1,
    correlationId
  );

  const requireSecretKey = parseBooleanFlag(
    env["ORACLE_REQUIRE_SECRET_KEY"],
    "ORACLE_REQUIRE_SECRET_KEY",
    correlationId
  );

  const { secretKey, signerPublicKey } = resolveSignerKey(
    env["ORACLE_SECRET_KEY"],
    requireSecretKey,
    correlationId
  );

  const trustedSignerPublicKey = parseTrustedSigner(
    env["ORACLE_SIGNER_PUBLIC_KEY"],
    correlationId
  );

  if (
    trustedSignerPublicKey !== undefined &&
    signerPublicKey !== undefined &&
    trustedSignerPublicKey !== signerPublicKey
  ) {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_SIGNER_MISMATCH,
      "ORACLE_SIGNER_PUBLIC_KEY",
      "ORACLE_SIGNER_PUBLIC_KEY does not match the public key derived from ORACLE_SECRET_KEY",
      correlationId
    );
  }

  return {
    pollIntervalMs,
    challengeWindowSeconds,
    logLevel,
    secretKey,
    signerPublicKey,
    trustedSignerPublicKey,
    primaryTimeoutMs,
    fallbackTimeoutMs,
    minConfidenceThreshold,
  };
}

/**
 * Resolve and validate the signing key (#1180).
 *
 * Deny-by-default: when `requireSecretKey` is set, a missing key throws
 * `ORACLE_CONFIG_MISSING_SECRET`. A present key that is not a Stellar secret
 * key throws `ORACLE_CONFIG_INVALID_SECRET`. The key value is never included
 * in error messages.
 */
function resolveSignerKey(
  rawSecretKey: string | undefined,
  requireSecretKey: boolean,
  correlationId: string
): { secretKey: string | undefined; signerPublicKey: string | undefined } {
  if (rawSecretKey === undefined || rawSecretKey === "") {
    if (requireSecretKey) {
      throw new OracleConfigError(
        ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_MISSING_SECRET,
        "ORACLE_SECRET_KEY",
        "ORACLE_SECRET_KEY is required (ORACLE_REQUIRE_SECRET_KEY is set) but was not provided",
        correlationId
      );
    }
    return { secretKey: undefined, signerPublicKey: undefined };
  }

  if (!isStellarSecretKey(rawSecretKey)) {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_SECRET,
      "ORACLE_SECRET_KEY",
      "ORACLE_SECRET_KEY is not a valid Stellar secret key",
      correlationId
    );
  }

  let signerPublicKey: string;
  try {
    signerPublicKey = Keypair.fromSecret(rawSecretKey).publicKey();
  } catch {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_SECRET,
      "ORACLE_SECRET_KEY",
      "ORACLE_SECRET_KEY could not be loaded as a Stellar keypair",
      correlationId
    );
  }

  return { secretKey: rawSecretKey, signerPublicKey };
}

/** Validate the optional pinned trusted signer (#1113). */
function parseTrustedSigner(
  raw: string | undefined,
  correlationId: string
): string | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if (!isStellarPublicKey(raw)) {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      "ORACLE_SIGNER_PUBLIC_KEY",
      "ORACLE_SIGNER_PUBLIC_KEY is not a valid Stellar account id",
      correlationId
    );
  }
  return raw;
}

/** Parse a boolean-ish flag; only explicit truthy/falsy strings are accepted. */
function parseBooleanFlag(
  raw: string | undefined,
  variable: string,
  correlationId: string
): boolean {
  if (raw === undefined || raw === "") {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new OracleConfigError(
    ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
    variable,
    `${variable} must be one of: true, false, 1, 0`,
    correlationId
  );
}

/** Parse a bounded integer, failing closed on any present-but-invalid value. */
function parseBoundedInt(
  raw: string | undefined,
  variable: string,
  defaultValue: number,
  max: number,
  correlationId: string
): number {
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      variable,
      `${variable} must be an integer in (0, ${max}]`,
      correlationId
    );
  }
  return parsed;
}

/** Parse a bounded float in (0, max], failing closed on invalid values. */
function parseBoundedFloat(
  raw: string | undefined,
  variable: string,
  defaultValue: number,
  max: number,
  correlationId: string
): number {
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      variable,
      `${variable} must be a number in (0, ${max}]`,
      correlationId
    );
  }
  return parsed;
}

/** Parse and validate the log level, defaulting when unset. */
function parseLogLevel(raw: string | undefined, variable: string): LogLevel {
  if (raw === undefined || raw === "") {
    return DEFAULT_LOG_LEVEL;
  }
  if (!VALID_LOG_LEVELS.has(raw)) {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      variable,
      `${variable} must be one of: debug, info, warn, error`
    );
  }
  return raw as LogLevel;
}
