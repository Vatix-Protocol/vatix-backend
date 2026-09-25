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

export type LogLevel = "debug" | "info" | "warn" | "error";

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
   */
  secretKey: string | undefined;
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

type Env = Record<string, string | undefined>;

/**
 * Read and validate oracle environment variables.
 *
 * @param env - Environment map (defaults to `process.env`).
 * @returns Validated OracleConfig.
 * @throws {Error} When any present variable fails validation.
 */
export function loadOracleConfig(env: Env = process.env): OracleConfig {
  const pollIntervalMs = getOraclePollIntervalMs();

  const challengeWindowSeconds = parseOptionalPositiveInt(
    env["ORACLE_CHALLENGE_WINDOW_SECONDS"],
    "ORACLE_CHALLENGE_WINDOW_SECONDS",
    DEFAULT_CHALLENGE_WINDOW_SECONDS
  );

  const logLevel = parseLogLevel(env["ORACLE_LOG_LEVEL"], "ORACLE_LOG_LEVEL");

  const primaryTimeoutMs = parseOptionalPositiveInt(
    env["ORACLE_PRIMARY_TIMEOUT_MS"],
    "ORACLE_PRIMARY_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS
  );

  const fallbackTimeoutMs = parseOptionalPositiveInt(
    env["ORACLE_FALLBACK_TIMEOUT_MS"],
    "ORACLE_FALLBACK_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS
  );

  const minConfidenceThreshold = parseOptionalUnitInterval(
    env["ORACLE_MIN_CONFIDENCE_THRESHOLD"],
    "ORACLE_MIN_CONFIDENCE_THRESHOLD",
    DEFAULT_MIN_CONFIDENCE_THRESHOLD
  );

  return {
    pollIntervalMs,
    challengeWindowSeconds,
    logLevel,
    secretKey: env["ORACLE_SECRET_KEY"] ?? undefined,
    primaryTimeoutMs,
    fallbackTimeoutMs,
    minConfidenceThreshold,
  };
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
    throw new Error(
      `${name} must be a number between 0 and 1, got: ${JSON.stringify(raw)}`
    );
  }

  return value;
}

function parseOptionalPositiveInt(
  raw: string | undefined,
  name: string,
  defaultValue: number
): number {
  if (raw === undefined || raw === "") {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be a positive integer, got: ${JSON.stringify(raw)}`
    );
  }

  return value;
}

function parseLogLevel(raw: string | undefined, name: string): LogLevel {
  if (raw === undefined || raw === "") {
    return DEFAULT_LOG_LEVEL;
  }

  if (!VALID_LOG_LEVELS.has(raw)) {
    throw new Error(
      `${name} must be one of ${[...VALID_LOG_LEVELS].join(" | ")}, got: ${JSON.stringify(raw)}`
    );
  }

  return raw as LogLevel;
}
