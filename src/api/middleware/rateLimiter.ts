import type { FastifyRequest, FastifyReply } from "fastify";

interface WindowEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, WindowEntry>();

// Defaults: 100 requests per 60 seconds per IP
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX) || 100;

export function rateLimiter(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void
): void {
  const key =
    (request.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ||
    request.socket.remoteAddress ||
    "unknown";

  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now >= entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS });
    done();
    return;
  }

  entry.count += 1;

  if (entry.count > MAX_REQUESTS) {
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
