export type NodeEnv = "development" | "test" | "production";

/**
 * Resolves allowed CORS origins from env, matching API and indexer HTTP surfaces.
 *
 * Production rules (NODE_ENV=production):
 * - All origins MUST use https://. Any http:// or scheme-less origin throws.
 * - If CORS_ALLOWED_ORIGINS is unset/empty the returned list is empty; the
 *   caller (corsPlugin) must treat an empty allowlist as fail-closed.
 *
 * Development/test rules:
 * - http:// origins are accepted.
 * - Defaults to localhost:3000 and localhost:5173 when the env var is unset.
 */
export function resolveCorsAllowedOrigins(
  nodeEnv: NodeEnv,
  rawCors: string | undefined
): string[] {
  if (rawCors && rawCors.trim() !== "") {
    const origins = rawCors
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);

    if (nodeEnv === "production") {
      const insecure = origins.filter((o) => !o.startsWith("https://"));
      if (insecure.length > 0) {
        throw new Error(
          `CORS misconfiguration: all origins must use https:// in production. ` +
            `Insecure origin(s): ${insecure.join(", ")}`
        );
      }
    }

    return origins;
  }

  if (nodeEnv === "production") {
    return [];
  }

  return ["http://localhost:3000", "http://localhost:5173"];
}
