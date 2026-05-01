/**
 * Fail-fast startup validation for required environment variables.
 *
 * Call requireEnv() once at boot time with the list of keys your service
 * needs. If any are missing or empty the process exits immediately with
 * code 1 and prints exactly which keys are absent — no silent defaults,
 * no lazy runtime failures.
 *
 * @module packages/shared/src/requireEnv
 */

/**
 * Assert that every key in `keys` is present and non-empty in `env`.
 *
 * Exits the process with code 1 when one or more keys are missing.
 * Accepts an optional `env` parameter (defaults to `process.env`) so
 * the function is fully testable without touching real environment state.
 *
 * @param keys - Environment variable names that must be present.
 * @param env  - Environment map to check against (default: process.env).
 *
 * @example
 * // At the top of your service entry point:
 * requireEnv(["DATABASE_URL", "API_KEY", "REDIS_URL"]);
 */
export function requireEnv(
  keys: string[],
  env: Record<string, string | undefined> = process.env
): void {
  const missing = keys.filter((key) => {
    const value = env[key];
    return value === undefined || value.trim() === "";
  });

  if (missing.length === 0) return;

  const list = missing.map((k) => `  - ${k}`).join("\n");
  console.error(
    `[requireEnv] Missing required environment variable${missing.length > 1 ? "s" : ""}:\n${list}`
  );

  process.exit(1);
}
