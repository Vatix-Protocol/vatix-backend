/**
 * Application configuration parsed and validated from environment variables.
 *
 * Oracle challenge window:
 *   ORACLE_CHALLENGE_WINDOW_SECONDS — duration of the resolution challenge period
 *   in whole seconds (integer, minimum 1). All window calculations use UTC timestamps.
 *   Example: 86400 = 24 hours, 3600 = 1 hour.
 */

function requirePositiveInt(name: string, fallback?: number): number {
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

  return value;
}

export const config = {
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
