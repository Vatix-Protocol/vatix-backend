/**
 * Application configuration parsed and validated from environment variables.
 *
 * NODE_ENV:
 *   Accepted values: development | test | production (default: development)
 *
 * Oracle challenge window:
 *   ORACLE_CHALLENGE_WINDOW_SECONDS — duration of the resolution challenge period
 *   in whole seconds (integer, minimum 1). All window calculations use UTC timestamps.
 *   Example: 86400 = 24 hours, 3600 = 1 hour.
 */

export type NodeEnv = "development" | "test" | "production";

const ACCEPTED_NODE_ENVS: NodeEnv[] = ["development", "test", "production"];

function loadNodeEnv(): NodeEnv {
  const raw = process.env.NODE_ENV ?? "development";
  if (!ACCEPTED_NODE_ENVS.includes(raw as NodeEnv)) {
    throw new Error(
      `NODE_ENV must be one of ${ACCEPTED_NODE_ENVS.join(" | ")}, got: ${JSON.stringify(raw)}`
    );
  }
  return raw as NodeEnv;
}

function requirePositiveInt(
  name: string,
  fallback?: number,
  max?: number
): number {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `Environment variable ${name} must be a positive integer, got: ${JSON.stringify(raw)}`
    );
  }

  if (max !== undefined && value > max) {
    throw new Error(
      `Environment variable ${name} must be <= ${max}, got: ${JSON.stringify(raw)}`
    );
  }

  return value;
}

export const config = {
  /**
   * Current runtime environment. Constrained to development | test | production.
   * Configured via NODE_ENV (default: development).
   */
  nodeEnv: loadNodeEnv(),
  /**
   * TCP port the API server binds to.
   * Must be a positive integer in the range 1–65535.
   * Configured via PORT (default: 3000).
   */
  port: requirePositiveInt("PORT", 3000, 65535),
  /**
   * Duration of the oracle resolution challenge window in seconds.
   * Must be a positive integer. All window boundary calculations use UTC.
   * Configured via ORACLE_CHALLENGE_WINDOW_SECONDS (default: 86400 = 24 h).
   */
  oracle: {
    challengeWindowSeconds: requirePositiveInt(
      "ORACLE_CHALLENGE_WINDOW_SECONDS",
      86400
    ),
  },
} as const;
