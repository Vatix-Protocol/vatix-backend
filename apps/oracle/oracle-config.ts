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
}

const VALID_LOG_LEVELS: ReadonlySet<string> = new Set([
  "debug",
  "info",
  "warn",
  "error",
]);

const DEFAULT_CHALLENGE_WINDOW_SECONDS = 86_400;
const DEFAULT_LOG_LEVEL: LogLevel = "info";

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

  return {
    pollIntervalMs,
    challengeWindowSeconds,
    logLevel,
    secretKey: env["ORACLE_SECRET_KEY"] ?? undefined,
  };
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
