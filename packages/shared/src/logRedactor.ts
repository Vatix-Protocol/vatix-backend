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

/** Placeholder substituted for content dropped by the depth/circularity guard. */
export const REDACTION_TRUNCATED = "[REDACTED:TRUNCATED]";

/**
 * Maximum object depth walked during redaction.
 *
 * Beyond this depth a value is replaced with {@link REDACTION_TRUNCATED}
 * rather than returned as-is. Returning the raw value would be a fail-OPEN
 * hole: a secret nested past the limit would be logged in plaintext, which is
 * exactly the case redaction exists to prevent. Failing closed costs a little
 * log detail in pathological payloads and closes the leak.
 */
export const MAX_REDACTION_DEPTH = 10;

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
 * Fails **closed** on adversarial input:
 *   - Depth beyond {@link MAX_REDACTION_DEPTH} is replaced with
 *     {@link REDACTION_TRUNCATED}, never passed through unredacted.
 *   - A value already seen on the current branch (a cycle) is replaced rather
 *     than recursed into forever.
 *
 * Non-object values are returned as-is.
 */
export function redactObject(
  value: unknown,
  _depth = 0,
  // Ancestors on the current path — a Set gives O(1) cycle detection while
  // still allowing the same object to appear in sibling branches.
  _seen: Set<object> = new Set()
): unknown {
  // Guard against deeply nested / circular structures. Fail closed: truncating
  // is preferable to emitting an unredacted subtree.
  if (_depth > MAX_REDACTION_DEPTH) return REDACTION_TRUNCATED;

  if (Array.isArray(value)) {
    // A cycle would otherwise recurse until the depth guard trips, which
    // truncates a lot of otherwise-useful log context. Detect it directly.
    if (_seen.has(value)) return REDACTION_TRUNCATED;
    _seen.add(value);
    try {
      return value.map((item) => redactObject(item, _depth + 1, _seen));
    } finally {
      _seen.delete(value);
    }
  }

  if (value !== null && typeof value === "object") {
    if (_seen.has(value)) return REDACTION_TRUNCATED;
    _seen.add(value);
    try {
      const result: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>)) {
        if (isSensitiveKey(k)) {
          result[k] = REDACTED;
          continue;
        }
        // Read the value inside its own try: a hostile or lazy getter must not
        // be able to throw out of the logger, which callers invoke from catch
        // blocks where a throw would mask the original failure.
        let v: unknown;
        try {
          v = (value as Record<string, unknown>)[k];
        } catch {
          result[k] = REDACTION_TRUNCATED;
          continue;
        }
        try {
          result[k] = redactObject(v, _depth + 1, _seen);
        } catch {
          result[k] = REDACTION_TRUNCATED;
        }
      }
      return result;
    } finally {
      _seen.delete(value);
    }
  }

  return value;
}

/**
 * Redacts credentials embedded in free text.
 *
 * `redactObject` only inspects *keys*. Real call sites also interpolate secrets
 * into the message itself — e.g.
 * `logger.info(\`connect failed for ${redisUrl}\`)` — which key-based redaction
 * cannot see. This scrubs the common credential shapes out of a string:
 *
 *   - URL userinfo:      redis://user:pass@host  ->  redis://user:[REDACTED]@host
 *   - key=value secrets: password=hunter2        ->  password=[REDACTED]
 *   - Bearer tokens:     Authorization: Bearer x ->  Authorization: Bearer [REDACTED]
 *
 * Patterns are anchored to known credential markers so ordinary prose and
 * identifiers (market ids, hashes, stream ids) are left untouched — an
 * over-eager scrub would make the logs useless during an incident.
 */
export function redactText(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;

  return (
    text
      // Bearer/Basic runs FIRST: otherwise the `authorization:` key=value rule
      // below matches "Authorization: Bearer" and redacts only the scheme word,
      // leaving the actual token sitting right after it in the log line.
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`)
      // scheme://user:password@host -> keep user, drop the password
      .replace(
        /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/g,
        `$1:${REDACTED}@`
      )
      // key=value / key: value for known credential markers.
      // The value pattern requires at least one character that is not `]` or
      // `[`, so a neighbouring already-redacted token ("Authorization: Bearer
      // [REDACTED]") is not swallowed a second time, mangling the scheme word.
      .replace(
        /\b(password|passwd|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|private[_-]?key|secret[_-]?key|authorization)\b(\s*[:=]\s*)(?!(?:Bearer|Basic)\b)(?:"[^"]*"|'[^']*'|[^\s,;)\][&]+)/gi,
        `$1$2${REDACTED}`
      )
  );
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
