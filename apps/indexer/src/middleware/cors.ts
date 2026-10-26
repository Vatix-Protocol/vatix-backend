import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyCors from '@fastify/cors';

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
export function getCorrelationId(req: FastifyRequest): string {
  const header =
    (req.headers['x-correlation-id'] as string | undefined) ??
    (req.headers['x-request-id'] as string | undefined) ??
    (req.headers['x-trace-id'] as string | undefined);
  if (header && header.trim().length > 0) {
    return header.trim();
  }
  return crypto.randomUUID();
}

/**
 * Parse a comma-separated allowlist of origins into a normalized array.
 * Empty entries (from leading/trailing commas or whitespace) are dropped.
 * Returns an empty array when `raw` is undefined, null, or blank — callers
 * interpret that as "no restriction" (wildcard mode).
 *
 * @param raw - Raw env-var value, e.g. "https://app.vatix.io, https://admin.vatix.io"
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw == null || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Resolve the configured CORS allowlist from the environment.
 *
 * Reads `CORS_ALLOWED_ORIGINS` (comma-separated list of origins).
 * Returns `[]` when the variable is unset, empty, or whitespace-only.
 * Never falls back to `*` — callers decide whether an empty list means
 * "open wildcard" (dev) or "deny all" (hardened production).
 *
 * @param raw - Optional override; defaults to process.env.CORS_ALLOWED_ORIGINS.
 */
export function resolveAllowedOrigins(
  raw: string | undefined = typeof process !== 'undefined'
    ? process.env?.CORS_ALLOWED_ORIGINS
    : undefined,
): string[] {
  return parseAllowedOrigins(raw);
}

/**
 * Fastify CORS plugin for the indexer HTTP server.
 *
 * Behaviour:
 * - When `allowedOrigins` is empty (env var unset), the policy falls through
 *   to a wildcard `*`  — this is dev/local mode.
 * - When `allowedOrigins` is non-empty, only listed origins are echoed back
 *   in `Access-Control-Allow-Origin`; all others receive no CORS headers.
 *   `Vary: Origin` is set so CDN/proxy caches store per-origin variants.
 * - Preflight `OPTIONS` requests always return 204.
 * - `Access-Control-Allow-Origin: *` is NEVER emitted when an allowlist is
 *   configured.
 *
 * Wire it up via `app.register(indexerCorsPlugin)`.
 */
export async function indexerCorsPlugin(app: FastifyInstance): Promise<void> {
  const allowedOrigins = resolveAllowedOrigins();

  await app.register(fastifyCors, {
    origin:
      allowedOrigins.length === 0
        ? '*'
        : (requestOrigin, callback) => {
            if (!requestOrigin) {
              // No Origin header — no CORS headers set (not a cross-origin request).
              callback(null, false);
              return;
            }
            const allowed = allowedOrigins.some(
              (o) => o.toLowerCase() === requestOrigin.toLowerCase(),
            );
            callback(null, allowed ? requestOrigin : false);
          },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Correlation-Id',
      'X-Request-Id',
    ],
    // Credentials are only meaningful when an explicit origin is echoed.
    credentials: allowedOrigins.length > 0,
  });
}

/**
 * Standalone CORS middleware factory (non-Fastify contexts / unit tests).
 *
 * Accepts an explicit `allowedOrigins` list or falls back to
 * `resolveAllowedOrigins()`.  When the list is non-empty:
 *   - Only an allowlisted request Origin is echoed back.
 *   - Non-allowlisted or absent Origin → no `Access-Control-Allow-Origin` header.
 *   - `Vary: Origin` is always set so caches do not collapse per-origin responses.
 *
 * When the list is empty the function behaves as a public wildcard (dev mode).
 * `Access-Control-Allow-Origin: *` is NEVER emitted when an allowlist is
 * configured.
 */
export function cors(options: { allowedOrigins?: string[] } = {}) {
  const allowedOrigins = options.allowedOrigins ?? resolveAllowedOrigins();
  const allowSet = new Set(allowedOrigins.map((o) => o.toLowerCase()));
  const echoMode = allowSet.size > 0;

  return async (req: FastifyRequest, reply: FastifyReply) => {
    const requestOrigin = req.headers['origin'] as string | undefined;

    if (!echoMode) {
      reply.header('Access-Control-Allow-Origin', '*');
    } else {
      reply.header('Vary', 'Origin');
      if (requestOrigin && allowSet.has(requestOrigin.toLowerCase())) {
        reply.header('Access-Control-Allow-Origin', requestOrigin);
        reply.header('Access-Control-Allow-Credentials', 'true');
      }
      // Non-allowlisted or absent origin → no Access-Control-Allow-Origin set.
    }

    reply.header(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    );
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Correlation-Id, X-Request-Id',
    );

    if (req.method === 'OPTIONS') {
      return reply.status(204).send('');
    }
  };
}
