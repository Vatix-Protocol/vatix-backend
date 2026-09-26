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
  /**
   * Dry-run mode (#1146). When `true`, the oracle poll loop resolves markets
   * and evaluates the confidence gate but does **not** write `OracleReport`
   * rows, sign reports, or enqueue anything for on-chain submission. Use it to
   * validate provider/allowlist wiring and confidence thresholds against live
   * data before enabling a real submission path. Never a substitute for
   * reviewing the fail-closed policy.
   */
  dryRun: boolean;
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
 * Dry-run defaults to `false` so an unconfigured deployment always runs the
 * real submission path; enabling it is an explicit, deliberate action (#1146).
 */
const DEFAULT_DRY_RUN = false;

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

  const dryRun = parseOptionalBoolean(
    env["ORACLE_DRY_RUN"],
    "ORACLE_DRY_RUN",
    DEFAULT_DRY_RUN
  );

  return {
    pollIntervalMs,
    challengeWindowSeconds,
    logLevel,
    secretKey: env["ORACLE_SECRET_KEY"] ?? undefined,
    primaryTimeoutMs,
    fallbackTimeoutMs,
    minConfidenceThreshold,
    dryRun,
  };
}

/**
 * Parse an optional boolean environment variable. Accepts `true`/`false` and
 * `1`/`0` (case-insensitive, surrounding whitespace ignored) and throws on
 * anything else so a typo like `ORACLE_DRY_RUN=yes` cannot silently resolve to
 * `false` and start submitting on-chain (#1146).
 */
function parseOptionalBoolean(
  raw: string | undefined,
  name: string,
  defaultValue: boolean
): boolean {
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }

  throw new Error(
    `${name} must be a boolean (true/false), got: ${JSON.stringify(raw)}`
  );
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
