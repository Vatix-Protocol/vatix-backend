/**
 * Safe JSON parsing for untrusted Horizon/RPC payloads before they reach
 * Prisma. Guards against prototype pollution ("__proto__", "constructor",
 * "prototype" keys) that JSON.parse + naive object spreading/merging would
 * otherwise let an attacker-controlled Horizon response inject into the
 * indexer's runtime prototypes.
 */

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class UnsafeJsonError extends Error {
  constructor(public readonly path: string) {
    super(`Unsafe key "${path}" detected while parsing untrusted JSON payload`);
    this.name = "UnsafeJsonError";
  }
}

export interface SafeJsonOptions {
  /**
   * When true, dangerous keys are stripped and parsing continues (useful
   * for local/dev stubs replaying fixture data). When false, parsing
   * throws UnsafeJsonError immediately. Defaults to the fail-fast behavior
   * in NODE_ENV=production and to stripping otherwise.
   */
  strictMode?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitize(value: unknown, path: string, strict: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitize(item, `${path}[${index}]`, strict));
  }

  if (isPlainObject(value)) {
    const clean: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) {
        if (strict) {
          throw new UnsafeJsonError(path ? `${path}.${key}` : key);
        }
        // Drop the key entirely rather than copying it onto `clean`.
        continue;
      }
      clean[key] = sanitize(value[key], path ? `${path}.${key}` : key, strict);
    }
    return clean;
  }

  return value;
}

function defaultStrictMode(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Parse untrusted JSON text and strip/reject prototype-pollution vectors
 * before the resulting object is passed to Prisma create/update calls.
 *
 * In production (or when `strictMode: true` is passed explicitly), a
 * payload containing `__proto__`/`constructor`/`prototype` keys throws
 * `UnsafeJsonError` instead of being silently sanitized — there is no
 * silent fallback that lets a malformed Horizon payload continue on to
 * a write in production.
 */
export function safeJsonParse<T = unknown>(
  text: string,
  options: SafeJsonOptions = {}
): T {
  const strict = options.strictMode ?? defaultStrictMode();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `safeJsonParse: invalid JSON payload (${err instanceof Error ? err.message : String(err)})`
    );
  }

  return sanitize(parsed, "", strict) as T;
}

/**
 * Sanitize an already-parsed object graph (e.g. a value that came from a
 * library's own JSON.parse, such as an HTTP client's response body) using
 * the same rules as safeJsonParse.
 */
export function safeJsonSanitize<T = unknown>(
  value: unknown,
  options: SafeJsonOptions = {}
): T {
  const strict = options.strictMode ?? defaultStrictMode();
  return sanitize(value, "", strict) as T;
}
