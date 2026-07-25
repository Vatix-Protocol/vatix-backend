export type NodeEnv = "development" | "test" | "production";

/**
 * Resolves allowed CORS origins from env, matching API and indexer HTTP surfaces.
 */
export function resolveCorsAllowedOrigins(
  nodeEnv: NodeEnv,
  rawCors: string | undefined
): string[] {
  if (rawCors && rawCors.trim() !== "") {
    return rawCors
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  if (nodeEnv === "production") {
    return [];
  }

  return ["http://localhost:3000", "http://localhost:5173"];
}
