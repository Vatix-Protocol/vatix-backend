/**
 * Centralized log redaction for sensitive fields.
 *
 * Any key whose name matches SENSITIVE_KEYS will have its value replaced with
 * the REDACTED placeholder before the log entry is serialized. This prevents
 * secrets, tokens, and credentials from leaking into log streams.
 *
 * Review and extend SENSITIVE_KEYS periodically as new sensitive fields appear.
 */

export const REDACTED = "[REDACTED]";

/**
 * Canonical set of sensitive field names (lower-cased for case-insensitive
 * matching). Add new entries here when new sensitive fields are introduced.
 */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  // Auth / identity
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "apikey",
  "api_key",
  "x-api-key",
  "authorization",
  "auth",
  // Cookies / sessions
  "cookie",
  "set-cookie",
  "session",
  "sessionid",
  "session_id",
  // Cryptographic material
  "privatekey",
  "private_key",
  "secretkey",
  "secret_key",
  "signingkey",
  "signing_key",
  "mnemonic",
  "seed",
  "keypair",
  // Network / infra
  "x-auth-token",
  "x-user-token",
  "connectionstring",
  "connection_string",
  "databaseurl",
  "database_url",
  "db_url",
  "redis_url",
  "redisurl",
  // PII
  "ssn",
  "creditcard",
  "credit_card",
  "cvv",
  "pin",
]);

/**
 * Returns true when the given key should be redacted.
 * Comparison is case-insensitive.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

/**
 * Recursively redacts sensitive fields in a plain object or array.
 * Returns a new object — the original is never mutated.
 *
 * Non-object values are returned as-is.
 */
export function redactObject(value: unknown, _depth = 0): unknown {
  // Guard against deeply nested / circular structures
  if (_depth > 10) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, _depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = isSensitiveKey(k) ? REDACTED : redactObject(v, _depth + 1);
    }
    return result;
  }

  return value;
}

/**
 * Redacts sensitive fields from a log metadata object.
 * Safe to call with undefined — returns undefined in that case.
 */
export function redactMeta(
  meta: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (meta === undefined) return undefined;
  return redactObject(meta) as Record<string, unknown>;
}
