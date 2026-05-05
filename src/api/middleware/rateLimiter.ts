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

/** Clear all rate limit counters — for use in tests only. */
export function clearRateLimitStores(): void {
  stores.clear();
}

// ---------------------------------------------------------------------------
// Limit tiers
// ---------------------------------------------------------------------------

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

/**
 * Attach quota-visibility headers to every response (2xx and 429).
 *
 * Header names follow the IETF RateLimit header fields draft
 * (draft-ietf-httpapi-ratelimit-headers):
 *
 *   RateLimit-Limit     — the maximum number of requests allowed in the window
 *   RateLimit-Remaining — requests still available in the current window
 *   RateLimit-Reset     — Unix timestamp (seconds) when the window resets
 */
function setQuotaHeaders(
  reply: FastifyReply,
  limit: number,
  remaining: number,
  resetAt: number
): void {
  reply
    .header("RateLimit-Limit", String(limit))
    .header("RateLimit-Remaining", String(Math.max(0, remaining)))
    .header("RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
}

function applyLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
  tier: string,
  windowMsEnv: string,
  maxEnv: string,
  defaultWindowMs: number,
  defaultMax: number
): void {
  const windowMs = Number(process.env[windowMsEnv]) || defaultWindowMs;
  const maxRequests = Number(process.env[maxEnv]) || defaultMax;
  const key = extractIp(request);
  const store = getStore(tier);
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now >= entry.resetAt) {
    const newEntry: WindowEntry = { count: 1, resetAt: now + windowMs };
    store.set(key, newEntry);
    setQuotaHeaders(reply, maxRequests, maxRequests - 1, newEntry.resetAt);
    done();
    return;
  }

  entry.count += 1;
  const remaining = maxRequests - entry.count;

  if (entry.count > maxRequests) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    setQuotaHeaders(reply, maxRequests, 0, entry.resetAt);
    reply.status(429).header("Retry-After", String(retryAfter)).send({
      error: "Too Many Requests",
      code: "RATE_LIMITED",
      statusCode: 429,
      retryAfter,
    });
    return;
  }

  setQuotaHeaders(reply, maxRequests, remaining, entry.resetAt);
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
  applyLimit(
    request,
    reply,
    done,
    "global",
    "RATE_LIMIT_WINDOW_MS",
    "RATE_LIMIT_MAX",
    60_000,
    100
  );
}

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
    "RATE_LIMIT_HEAVY_WINDOW_MS",
    "RATE_LIMIT_HEAVY_MAX",
    60_000,
    20
  );
}

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
    "RATE_LIMIT_WRITE_WINDOW_MS",
    "RATE_LIMIT_WRITE_MAX",
    60_000,
    10
  );
}
