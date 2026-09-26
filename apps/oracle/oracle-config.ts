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
 * Fail-closed rules (#1115):
 *   - Any *present* variable that cannot be parsed, or that falls outside its
 *     bounds, throws `OracleConfigError` — a broken value is never silently
 *     replaced by a default.
 *   - `ORACLE_SECRET_KEY`, when set, must be a Stellar secret key (`S…`).
 *   - `ORACLE_SIGNER_PUBLIC_KEY`, when set, must be a Stellar account id
 *     (`G…`) and must equal the public key derived from `ORACLE_SECRET_KEY`
 *     (`ORACLE_CONFIG_SIGNER_MISMATCH`) — this is what catches a deployment
 *     that loaded the wrong network's keypair.
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

  const minConfidenceThreshold = parseOptionalUnitInterval(
    env["ORACLE_MIN_CONFIDENCE_THRESHOLD"],
    "ORACLE_MIN_CONFIDENCE_THRESHOLD",
    DEFAULT_MIN_CONFIDENCE_THRESHOLD
  );

  const secretKey = parseOptionalSecretKey(env, correlationId);
  const signerPublicKey = secretKey
    ? Keypair.fromSecret(secretKey).publicKey()
    : undefined;
  const trustedSignerPublicKey = parseOptionalTrustedSigner(
    env,
    signerPublicKey,
    correlationId
  );

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
 * Validate `ORACLE_SECRET_KEY` when present. Rejects anything that is not a
 * Stellar secret key so a placeholder or truncated key fails at startup
 * rather than at the first signature (#1115).
 */
function parseOptionalSecretKey(
  env: Env,
  correlationId: string
): string | undefined {
  const raw = env["ORACLE_SECRET_KEY"];
  if (raw === undefined || raw === "") {
    return undefined;
  }

  const secretKey = raw.trim();
  if (!isStellarSecretKey(secretKey)) {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      "ORACLE_SECRET_KEY",
      "ORACLE_SECRET_KEY must be a Stellar secret key (S...); generate one with `pnpm generate:keypair`",
      correlationId
    );
  }

  return secretKey;
}

/**
 * Validate `ORACLE_SIGNER_PUBLIC_KEY` when present and — when the signing
 * secret is also configured — require the two to agree, so testnet/mainnet
 * address drift fails at startup instead of at verification time (#1115).
 */
function parseOptionalTrustedSigner(
  env: Env,
  signerPublicKey: string | undefined,
  correlationId: string
): string | undefined {
  const raw = env["ORACLE_SIGNER_PUBLIC_KEY"]?.trim();
  if (!raw) {
    return undefined;
  }

  if (!isStellarPublicKey(raw)) {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      "ORACLE_SIGNER_PUBLIC_KEY",
      "ORACLE_SIGNER_PUBLIC_KEY must be a Stellar account id (G...)",
      correlationId
    );
  }

  if (signerPublicKey && signerPublicKey !== raw) {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_SIGNER_MISMATCH,
      "ORACLE_SIGNER_PUBLIC_KEY",
      `ORACLE_SIGNER_PUBLIC_KEY does not match the public key derived from ORACLE_SECRET_KEY (${signerPublicKey}). Refusing to start: this usually means the wrong network's keypair was loaded.`,
      correlationId
    );
  }

  return raw;
}

/**
 * Parse an optional positive integer that must not exceed `max`. The upper
 * bound catches unit mix-ups (milliseconds where seconds were expected).
 */
function parseBoundedInt(
  raw: string | undefined,
  name: string,
  defaultValue: number,
  max: number,
  correlationId: string
): number {
  const value = parseOptionalPositiveInt(
    raw,
    name,
    defaultValue,
    correlationId
  );
  if (value > max) {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      name,
      `${name} must be <= ${max}, got: ${value} (check for a unit mix-up)`
    );
  }
  return value;
}

/**
 * Parse an optional environment variable that must fall within [0, 1].
 * Used for confidence-threshold style settings.
 */
function parseOptionalUnitInterval(
  raw: string | undefined,
  name: string,
  defaultValue: number
): number {
  if (raw === undefined || raw === "") {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      name,
      `${name} must be a number between 0 and 1, got: ${JSON.stringify(raw)}`
    );
  }

  return value;
}

function parseOptionalPositiveInt(
  raw: string | undefined,
  name: string,
  defaultValue: number,
  correlationId: string = newConfigCorrelationId()
): number {
  if (raw === undefined || raw === "") {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      name,
      `${name} must be a positive integer, got: ${JSON.stringify(raw)}`,
      correlationId
    );
  }

  return value;
}

function parseLogLevel(raw: string | undefined, name: string): LogLevel {
  if (raw === undefined || raw === "") {
    return DEFAULT_LOG_LEVEL;
  }

  if (!VALID_LOG_LEVELS.has(raw)) {
    throw new OracleConfigError(
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      name,
      `${name} must be one of ${[...VALID_LOG_LEVELS].join(" | ")}, got: ${JSON.stringify(raw)}`
    );
  }

  return raw as LogLevel;
}
