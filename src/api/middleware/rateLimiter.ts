import type { FastifyRequest, FastifyReply } from "fastify";

interface WindowEntry {
  count: number;
  resetAt: number;
}

// Separate stores per limit tier so heavy-endpoint counters don't bleed into
// the global counter for the same IP.
const stores = new Map<string, Map<string, WindowEntry>>();

function getStore(tier: string): Map<string, WindowEntry> {
  let store = stores.get(tier);
  if (!store) {
    store = new Map();
    stores.set(tier, store);
  }
  return store;
}

// ---------------------------------------------------------------------------
// Limit tiers
// ---------------------------------------------------------------------------

/**
 * Global defaults: 100 req / 60 s per IP.
 * Override via RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX.
 */
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX) || 100;

/**
 * Heavy-endpoint defaults: 20 req / 60 s per IP.
 * These routes perform expensive DB queries (full-table scans, multi-join
 * reads, or write + matching-engine work) and need tighter controls to
 * prevent overload.
 *
 * Override via RATE_LIMIT_HEAVY_WINDOW_MS and RATE_LIMIT_HEAVY_MAX.
 */
const HEAVY_WINDOW_MS =
  Number(process.env.RATE_LIMIT_HEAVY_WINDOW_MS) || 60_000;
const HEAVY_MAX_REQUESTS = Number(process.env.RATE_LIMIT_HEAVY_MAX) || 20;

/**
 * Write-endpoint defaults: 10 req / 60 s per IP.
 * Mutation routes (order creation) carry the highest per-request cost
 * (validation, DB write, future matching-engine work).
 *
 * Override via RATE_LIMIT_WRITE_WINDOW_MS and RATE_LIMIT_WRITE_MAX.
 */
const WRITE_WINDOW_MS =
  Number(process.env.RATE_LIMIT_WRITE_WINDOW_MS) || 60_000;
const WRITE_MAX_REQUESTS = Number(process.env.RATE_LIMIT_WRITE_MAX) || 10;

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

function extractIp(request: FastifyRequest): string {
  return (
    (request.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ||
    request.socket.remoteAddress ||
    "unknown"
  );
}

function applyLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
  tier: string,
  windowMs: number,
  maxRequests: number
): void {
  const key = extractIp(request);
  const store = getStore(tier);
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now >= entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    done();
    return;
  }

  entry.count += 1;

  if (entry.count > maxRequests) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    reply
      .status(429)
      .header("Retry-After", String(retryAfter))
      .send({
        error: "Too Many Requests",
        code: "RATE_LIMITED",
        statusCode: 429,
        retryAfter,
      });
    return;
  }

  done();
}

// ---------------------------------------------------------------------------
// Exported middleware hooks
// ---------------------------------------------------------------------------

/**
 * Global rate limiter — applied to all routes as a baseline.
 * Limit: 100 req / 60 s (configurable via RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS).
 */
export function rateLimiter(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void
): void {
  applyLimit(request, reply, done, "global", WINDOW_MS, MAX_REQUESTS);
}

/**
 * Heavy-endpoint rate limiter — apply to routes that perform expensive reads.
 *
 * Affected routes:
 *   GET /markets                  — full-table scan, no cursor-based pagination
 *   GET /orders/user/:address     — paginated but requires two DB queries (findMany + count)
 *   GET /positions/user/:address  — findMany with market JOIN
 *
 * Limit: 20 req / 60 s (configurable via RATE_LIMIT_HEAVY_MAX / RATE_LIMIT_HEAVY_WINDOW_MS).
 */
export function heavyReadLimiter(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void
): void {
  applyLimit(
    request,
    reply,
    done,
    "heavy-read",
    HEAVY_WINDOW_MS,
    HEAVY_MAX_REQUESTS
  );
}

/**
 * Write-endpoint rate limiter — apply to mutation routes.
 *
 * Affected routes:
 *   POST /orders  — input validation, DB write, future matching-engine work
 *
 * Limit: 10 req / 60 s (configurable via RATE_LIMIT_WRITE_MAX / RATE_LIMIT_WRITE_WINDOW_MS).
 */
export function writeLimiter(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void
): void {
  applyLimit(
    request,
    reply,
    done,
    "write",
    WRITE_WINDOW_MS,
    WRITE_MAX_REQUESTS
  );
}
