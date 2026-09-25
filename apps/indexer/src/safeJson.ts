type JsonLike =
  | string
  | number
  | boolean
  | null
  | JsonLike[]
  | { [key: string]: JsonLike };

export interface SafeJsonOptions {
  /** Maximum length of the JSON string (default: 1,048,576 chars / 1MB). */
  maxLength?: number;
  /** Maximum nesting depth allowed (default: 32). */
  maxDepth?: number;
  /** Maximum array length allowed (default: 10,000). */
  maxArrayLength?: number;
  /** Maximum object key count allowed (default: 10,000). */
  maxObjectKeys?: number;
}

const DEFAULT_MAX_LENGTH = 1_048_576; // 1 MB
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_ARRAY_LENGTH = 10_000;
const DEFAULT_MAX_OBJECT_KEYS = 10_000;

function validateStructure(
  value: unknown,
  options: SafeJsonOptions,
  depth = 0
): boolean {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;
  const maxObjectKeys = options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS;

  if (depth > maxDepth) {
    return false;
  }

  if (Array.isArray(value)) {
    if (value.length > maxArrayLength) {
      return false;
    }
    for (const item of value) {
      if (!validateStructure(item, options, depth + 1)) {
        return false;
      }
    }
  } else if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > maxObjectKeys) {
      return false;
    }
    for (const key of keys) {
      if (
        !validateStructure(
          (value as Record<string, unknown>)[key],
          options,
          depth + 1
        )
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Safely parse a JSON string without throwing on invalid input.
 *
 * Enforces DoS limits (`maxLength`, `maxDepth`, `maxArrayLength`, `maxObjectKeys`).
 * Returns `{ ok: true, value }` on success and `{ ok: false, error }` on
 * failure so callers are forced to handle the error path explicitly — there
 * is no uncaught SyntaxError from event bodies.
 */
export function safeJsonParse<T = unknown>(
  raw: string,
  options?: SafeJsonOptions
): { ok: true; value: T } | { ok: false; error: SyntaxError } {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH;

  if (typeof raw !== "string") {
    return {
      ok: false,
      error: new SyntaxError("Input must be a string"),
    };
  }

  if (raw.length > maxLength) {
    return {
      ok: false,
      error: new SyntaxError(
        `JSON string exceeds maximum allowed length of ${maxLength} bytes`
      ),
    };
  }

  try {
    const parsed = JSON.parse(raw);
    const opts = options ?? {};
    if (!validateStructure(parsed, opts)) {
      return {
        ok: false,
        error: new SyntaxError(
          "JSON structure exceeds maximum allowed depth, array length, or object key count"
        ),
      };
    }
    return { ok: true, value: parsed as T };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof SyntaxError ? err : new SyntaxError(String(err)),
    };
  }
}

export function sanitizeForJson(
  value: unknown,
  options?: SafeJsonOptions,
  seen = new WeakSet<object>(),
  depth = 0
): JsonLike {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArrayLength = options?.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;
  const maxObjectKeys = options?.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS;

  if (depth > maxDepth) {
    return "[Depth Exceeded]";
  }

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
    const len = Math.min(value.length, maxArrayLength);
    const arr: JsonLike[] = [];
    for (let i = 0; i < len; i++) {
      arr.push(sanitizeForJson(value[i], options, seen, depth + 1));
    }
    if (value.length > maxArrayLength) {
      arr.push("[Array Truncated]");
    }
    return arr;
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

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const limitedKeys = keys.slice(0, maxObjectKeys);

    const out: { [key: string]: JsonLike } = {};
    for (const key of limitedKeys) {
      out[key] = sanitizeForJson(record[key], options, seen, depth + 1);
    }
    if (keys.length > maxObjectKeys) {
      out["[KeysTruncated]"] = true;
    }
    return out;
  }

  return String(value);
}

export function safeStringify(
  value: unknown,
  options?: SafeJsonOptions
): string {
  return JSON.stringify(sanitizeForJson(value, options));
}
