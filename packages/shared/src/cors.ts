export type NodeEnv = "development" | "test" | "production";

/**
 * Normalizes a configured origin to the exact form browsers send in the
 * `Origin` header: lowercase scheme + host, no trailing slash, no path/query.
 *
 * Browsers only ever send scheme://host[:port] for the `Origin` header, so an
 * allowlist entry written as `https://App.Vatix.IO/` or
 * `https://app.vatix.io/app` would never match and would silently deny a
 * legitimate client. Normalizing both sides at config time makes the exact
 * string comparison in the CORS middleware reliable.
 *
 * Returns `null` for entries that can never be a valid origin (empty,
 * `null`, `*`, or unparseable) so callers can drop them fail-closed.
 */
export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "null") {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  // An entry carrying a path, query, or fragment is not an origin; keeping the
  // host only would silently widen the allowlist to every path on that host.
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return null;
  }

  return `${url.protocol}//${url.host}`;
}

/**
 * True when `origin` exactly matches an entry in the allowlist.
 *
 * Exact-match only — no suffix/prefix wildcards. This is the single decision
 * point shared by the API and indexer CORS plugins, so a caller cannot
 * accidentally opt one HTTP surface into a looser policy than the other.
 */
export function isOriginAllowed(
  origin: string,
  allowedOrigins: string[]
): boolean {
  const normalized = normalizeOrigin(origin);
  if (normalized === null) {
    return false;
  }
  return allowedOrigins.some(
    (allowed) => normalizeOrigin(allowed) === normalized
  );
}

/**
 * Resolves allowed CORS origins from env, matching API and indexer HTTP surfaces.
 *
 * Production rules (NODE_ENV=production):
 * - All origins MUST use https://. Any http:// or scheme-less origin throws.
 * - A wildcard (`*`) or opaque (`null`) origin throws: this API sends
 *   `Access-Control-Allow-Credentials: true`, so a wildcard would let any
 *   site make credentialed cross-origin requests to the money path.
 * - Entries that are not a bare `scheme://host[:port]` origin (path, query,
 *   fragment, or unparseable) are dropped fail-closed with a warning-worthy
 *   omission rather than silently widening the policy.
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
    const entries = rawCors
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);

    const hasWildcard = entries.includes("*") || entries.includes("null");
    if (hasWildcard && nodeEnv === "production") {
      throw new Error(
        `CORS misconfiguration: '*' and 'null' origins are rejected in ` +
          `production because credentialed requests are enabled. List each ` +
          `frontend origin explicitly, e.g.: ` +
          `CORS_ALLOWED_ORIGINS=https://app.vatix.io`
      );
    }

    if (nodeEnv === "production") {
      const insecure = entries.filter((o) => !o.startsWith("https://"));
      if (insecure.length > 0) {
        throw new Error(
          `CORS misconfiguration: all origins must use https:// in production. ` +
            `Insecure origin(s): ${insecure.join(", ")}`
        );
      }
    }

    // '*' and 'null' normalize to null and are dropped here too, so a
    // wildcard pasted into a dev .env can never be promoted to production
    // unnoticed and the two environments share one parsing path.
    return entries.flatMap((entry) => {
      const normalized = normalizeOrigin(entry);
      return normalized === null ? [] : [normalized];
    });
  }

  if (nodeEnv === "production") {
    return [];
  }

  return ["http://localhost:3000", "http://localhost:5173"];
}
