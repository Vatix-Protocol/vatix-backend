type JsonLike =
  string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

/**
 * Safely parse a JSON string without throwing on invalid input.
 *
 * Returns `{ ok: true, value }` on success and `{ ok: false, error }` on
 * failure so callers are forced to handle the error path explicitly — there
 * is no uncaught SyntaxError from event bodies.
 */
export function safeJsonParse<T = unknown>(
  raw: string
): { ok: true; value: T } | { ok: false; error: SyntaxError } {
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof SyntaxError ? err : new SyntaxError(String(err)),
    };
  }
}

export function sanitizeForJson(
  value: unknown,
  seen = new WeakSet<object>()
): JsonLike {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForJson(item, seen));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? null,
    };
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);

    const out: { [key: string]: JsonLike } = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>
    )) {
      out[key] = sanitizeForJson(nested, seen);
    }
    return out;
  }

  return String(value);
}

export function safeStringify(value: unknown): string {
  return JSON.stringify(sanitizeForJson(value));
}
