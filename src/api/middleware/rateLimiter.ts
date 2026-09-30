import type { FastifyRequest, FastifyReply } from "fastify";
import { redis } from "../../services/redis.js";
import { config } from "../../config.js";

/**
 * Represents a single rate limit window entry for an IP address.
 * Tracks the number of requests and when the window resets.
 * (Kept for backward compatibility with tests that clear stores)
 */
export interface WindowEntry {
  count: number;
  resetAt: number;
}

/**
 * Rate limiter middleware function signature.
 * Follows Fastify's onRequest hook interface for middleware hooks.
 */
export type RateLimiterMiddleware = (
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void
) => void;

/**
 * Configuration for a rate limiter tier.
 * Defines the window duration and maximum request count.
 */
export interface RateLimiterConfig {
  tier: string;
  windowMs: number;
  maxRequests: number;
}

// In-memory fallback for tests (cleared via clearRateLimitStores)
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
  requestsSinceSweep = 0;
}

/** Number of tracked IP entries for a tier — for use in tests only. */
export function getRateLimitStoreSize(tier: string): number {
  return stores.get(tier)?.size ?? 0;
}

// Every IP that ever hits the server adds an entry that otherwise lives
// forever — entries are only overwritten, never removed, once their window
// has passed. On a long-running process behind a proxy (or facing spoofed
// X-Forwarded-For values) that's an unbounded memory leak. Sweep expired
// entries opportunistically off request volume instead of a background
// timer, so there's nothing to schedule or tear down on shutdown.
const SWEEP_EVERY_N_REQUESTS = 1000;
let requestsSinceSweep = 0;

/** Remove all entries whose window has already reset from every tier. */
export function sweepExpiredRateLimitEntries(now: number = Date.now()): void {
  for (const store of stores.values()) {
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) {
        store.delete(key);
      }
    }
  }
}

function maybeSweepExpiredEntries(now: number): void {
  requestsSinceSweep += 1;
  if (requestsSinceSweep >= SWEEP_EVERY_N_REQUESTS) {
    requestsSinceSweep = 0;
    sweepExpiredRateLimitEntries(now);
  }
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

function extractIp(request: FastifyRequest): string {
  // Fastify's request.ip respects the trustProxy configuration and will only
  // extract IPs from X-Forwarded-For if the proxy hop count is trustworthy.
  // For untrusted sources, it falls back to the direct socket address.
  return request.ip || request.socket.remoteAddress || "unknown";
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
  resetAtMs: number
): void {
  reply
    .header("RateLimit-Limit", String(limit))
    .header("RateLimit-Remaining", String(Math.max(0, remaining)))
    .header("RateLimit-Reset", String(Math.ceil(resetAtMs / 1000)));
}

/**
 * Apply distributed rate limiting using Redis-backed sliding window (ZSET).
 * Removes old entries outside the window, checks count, then adds current timestamp.
 * Production: fail closed if Redis is unreachable (reject request).
 */
async function applyLimitAsync(
  request: FastifyRequest,
  reply: FastifyReply,
  tier: string,
  windowMsEnv: string,
  maxEnv: string,
  defaultWindowMs: number,
  defaultMax: number
): Promise<void> {
  const windowMs = Number(process.env[windowMsEnv]) || defaultWindowMs;
  const maxRequests = Number(process.env[maxEnv]) || defaultMax;
  const ipKey = extractIp(request);
  const redisKey = redis.prefixed(`ratelimit:${tier}:${ipKey}`);
  const now = Date.now();
  const windowStart = now - windowMs;

  try {
    const client = await (redis as any).ensureConnected();

    // Remove entries older than window start (sliding window)
    await client.zremrangebyscore(redisKey, "-inf", windowStart);

    // Count current entries in window
    const count = await client.zcard(redisKey);
    const remaining = maxRequests - count;
    // The window resets when its *oldest* surviving entry ages out, not
    // `now + windowMs`. Deriving the reset from the current request would
    // push `RateLimit-Reset` forward on every call, so a client polling the
    // header would be told to wait a full window even though the oldest entry
    // — and therefore the real reset — is only seconds away. The oldest
    // entry's score is the window's true anchor.
    //
    // `zRangeWithScores` rather than `zRange(..., "WITHSCORES")`: the latter
    // silently drops the flag on this client and returns members only, which
    // would leave the score undefined and quietly reinstate the drift.
    const oldest = await client.zRangeWithScores(redisKey, 0, 0);
    const oldestScore = Number(oldest?.[0]?.score);
    const resetAtMs =
      Number.isFinite(oldestScore) && oldestScore > 0
        ? oldestScore + windowMs
        : now + windowMs;

    if (count >= maxRequests) {
      // Clamp to at least 1s: `Retry-After: 0` would instruct a client to
      // retry immediately, defeating the backoff it asked for.
      const retryAfter = Math.max(1, Math.ceil((resetAtMs - now) / 1000));
      setQuotaHeaders(reply, maxRequests, 0, resetAtMs);
      reply.status(429).header("Retry-After", String(retryAfter)).send({
        error: "Too Many Requests",
        code: "RATE_LIMITED",
        statusCode: 429,
        retryAfter,
      });
      return;
    }

    // Add current request with timestamp as score
    await client.zadd(redisKey, now, `${now}-${Math.random()}`);
    // Set expiry to window + 1 second to clean up old keys
    await client.expire(redisKey, Math.ceil(windowMs / 1000) + 1);

    setQuotaHeaders(reply, maxRequests, remaining, resetAtMs);
  } catch (error) {
    // Production: fail closed (reject request) if Redis unavailable
    if (config.nodeEnv === "production") {
      // The backoff is derived from the tier's own window rather than a
      // hardcoded 60s: a tier configured with a 15s window must not tell a
      // client to wait a minute, and a 5-minute window must not invite a
      // retry storm after 60s.
      const resetAtMs = now + windowMs;
      const retryAfter = Math.max(1, Math.ceil(windowMs / 1000));
      setQuotaHeaders(reply, maxRequests, 0, resetAtMs);
      reply.status(429).header("Retry-After", String(retryAfter)).send({
        error: "Too Many Requests",
        code: "RATE_LIMITED",
        statusCode: 429,
        retryAfter,
      });
      return;
    }

    // Fallback to in-memory for non-production
    const store = getStore(tier);
    maybeSweepExpiredEntries(now);
    const entry = store.get(ipKey);

    if (!entry || now >= entry.resetAt) {
      const newEntry: WindowEntry = { count: 1, resetAt: now + windowMs };
      store.set(ipKey, newEntry);
      setQuotaHeaders(reply, maxRequests, maxRequests - 1, newEntry.resetAt);
      return;
    }

    entry.count += 1;
    const remaining = maxRequests - entry.count;

    if (entry.count > maxRequests) {
      // Same clamp as the Redis path: a window that is about to roll over
      // must not yield `Retry-After: 0`.
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
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
  }
}

// ---------------------------------------------------------------------------
// Exported middleware hooks
// ---------------------------------------------------------------------------

/**
 * Global rate limiter — applied to all routes as a baseline.
 * Limit: 100 req / 60 s (configurable via RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS).
 * Uses Redis-backed sliding-window rate limiting across API replicas.
 * In production, fails closed if Redis is unreachable.
 */
export const rateLimiter: RateLimiterMiddleware = (request, reply, done) => {
  applyLimitAsync(
    request,
    reply,
    "global",
    "RATE_LIMIT_WINDOW_MS",
    "RATE_LIMIT_MAX",
    60_000,
    100
  )
    .then(() => done())
    .catch(() => done());
};

/**
 * Heavy read rate limiter — applied to expensive read endpoints.
 * Limit: 20 req / 60 s (configurable via RATE_LIMIT_HEAVY_MAX / RATE_LIMIT_HEAVY_WINDOW_MS).
 * Uses Redis-backed sliding-window rate limiting across API replicas.
 * In production, fails closed if Redis is unreachable.
 */
export const heavyReadLimiter: RateLimiterMiddleware = (
  request,
  reply,
  done
) => {
  applyLimitAsync(
    request,
    reply,
    "heavy-read",
    "RATE_LIMIT_HEAVY_WINDOW_MS",
    "RATE_LIMIT_HEAVY_MAX",
    60_000,
    20
  )
    .then(() => done())
    .catch(() => done());
};

/**
 * Write rate limiter — applied to mutation endpoints.
 * Limit: 10 req / 60 s (configurable via RATE_LIMIT_WRITE_MAX / RATE_LIMIT_WRITE_WINDOW_MS).
 * Uses Redis-backed sliding-window rate limiting across API replicas.
 * In production, fails closed if Redis is unreachable.
 */
export const writeLimiter: RateLimiterMiddleware = (request, reply, done) => {
  applyLimitAsync(
    request,
    reply,
    "write",
    "RATE_LIMIT_WRITE_WINDOW_MS",
    "RATE_LIMIT_WRITE_MAX",
    60_000,
    10
  )
    .then(() => done())
    .catch(() => done());
};

/**
 * Admin rate limiter — applied to all admin routes.
 * Stricter than the global baseline; admin operations are privileged and
 * already gated behind API-key + admin-role checks.
 * Limit: 30 req / 60 s (configurable via RATE_LIMIT_ADMIN_MAX / RATE_LIMIT_ADMIN_WINDOW_MS).
 * Uses Redis-backed sliding-window rate limiting across API replicas.
 * In production, fails closed if Redis is unreachable.
 */
export const adminLimiter: RateLimiterMiddleware = (request, reply, done) => {
  applyLimitAsync(
    request,
    reply,
    "admin",
    "RATE_LIMIT_ADMIN_WINDOW_MS",
    "RATE_LIMIT_ADMIN_MAX",
    60_000,
    30
  )
    .then(() => done())
    .catch(() => done());
};
