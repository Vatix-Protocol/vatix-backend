import type { Context, Next } from 'hono';

/**
 * Stable error codes for body-limit rejections (issue #1164).
 * Kept here so external entrypoints share a single source of truth.
 */
export const BODY_LIMIT_ERROR_CODE = 'BODY_TOO_LARGE' as const;

/**
 * Default maximum request body size in bytes (1 MiB).
 * Overridable via the BODY_LIMIT_BYTES env var so ops can tune per environment.
 */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * Resolve the configured body limit. Fail-closed: invalid or non-positive
 * values fall back to the safe default rather than disabling the limit.
 */
export function resolveBodyLimitBytes(
  raw: string | undefined = typeof process !== 'undefined'
    ? process.env?.BODY_LIMIT_BYTES
    : undefined,
): number {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_BODY_LIMIT_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BODY_LIMIT_BYTES;
  }
  return Math.floor(parsed);
}

/**
 * Extract a correlation id from the request, generating one when absent so
 * every rejection is traceable without leaking request contents.
 */
export function getCorrelationId(c: Context): string {
  const header =
    c.req.header('x-correlation-id') ??
    c.req.header('x-request-id') ??
    c.req.header('x-trace-id');
  if (header && header.trim().length > 0) {
    return header.trim();
  }
  return crypto.randomUUID();
}

/**
 * Body size limit middleware (issue #1164).
 *
 * Enforces a configurable maximum request body size on external HTTP
 * entrypoints. Oversized bodies are rejected fail-closed with HTTP 413 and a
 * stable error code. Runs before authz/rate-limit handlers so untrusted
 * clients cannot bypass the policy by sending large payloads.
 */
export function bodyLimit(options: { maxBytes?: number } = {}) {
  const maxBytes = options.maxBytes ?? resolveBodyLimitBytes();

  return async (c: Context, next: Next) => {
    const method = c.req.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

    if (hasBody) {
      const contentLength = c.req.header('content-length');
      if (contentLength !== undefined) {
        const declared = Number(contentLength);
        if (Number.isFinite(declared) && declared > maxBytes) {
          return rejectBodyTooLarge(c, maxBytes, declared);
        }
      }

      // Guard against missing/forged Content-Length by measuring the actual
      // payload. Fail-closed: reject when the real size exceeds the limit.
      const body = await c.req.raw.clone().arrayBuffer();
      if (body.byteLength > maxBytes) {
        return rejectBodyTooLarge(c, maxBytes, body.byteLength);
      }
    }

    await next();
  };
}

function rejectBodyTooLarge(c: Context, maxBytes: number, actualBytes: number) {
  const correlationId = getCorrelationId(c);
  // Ops-safe log: no request contents or secrets, only sizes and ids.
  console.warn(
    JSON.stringify({
      event: 'body_limit_rejected',
      code: BODY_LIMIT_ERROR_CODE,
      correlationId,
      method: c.req.method,
      path: c.req.path,
      maxBytes,
      actualBytes,
    }),
  );

  return c.json(
    {
      error: {
        code: BODY_LIMIT_ERROR_CODE,
        message: 'Request body exceeds the configured size limit',
        correlationId,
        maxBytes,
      },
    },
    413,
  );
}

/**
 * Parse a comma-separated allowlist of origins into a normalized set.
 * Empty entries are ignored; origins are compared case-insensitively.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Resolve the configured CORS allowlist from the environment.
 * Returns an empty list when unset, preserving the wildcard default.
 */
export function resolveAllowedOrigins(
  raw: string | undefined = typeof process !== 'undefined'
    ? process.env?.INDEXER_CORS_ALLOWED_ORIGINS
    : undefined,
): string[] {
  return parseAllowedOrigins(raw);
}

/**
 * CORS middleware. Kept intact; body-limit helpers above are additive so
 * existing consumers of this module are unaffected.
 *
 * When no allowlist is configured the policy is a public wildcard. When an
 * allowlist is provided, only listed origins are echoed back; unlisted origins
 * receive no allow-origin header. Credentials are only advertised when an
 * explicit origin is echoed.
 */
export function cors(options: { allowedOrigins?: string[] } = {}) {
  const allowedOrigins = options.allowedOrigins ?? resolveAllowedOrigins();
  const allowlist = new Set(allowedOrigins.map((origin) => origin.toLowerCase()));
  const echoMode = allowlist.size > 0;

  return async (c: Context, next: Next) => {
    const requestOrigin = c.req.header('origin');

    if (!echoMode) {
      c.header('Access-Control-Allow-Origin', '*');
    } else if (requestOrigin && allowlist.has(requestOrigin.toLowerCase())) {
      c.header('Access-Control-Allow-Origin', requestOrigin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Vary', 'Origin');
    }

    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Correlation-Id, X-Request-Id');

    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204);
    }

    await next();
  };
}
