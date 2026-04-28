import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";

// Headers that must never appear in logs (auth tokens, cookies, secrets).
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);

/**
 * Request logging middleware for Fastify.
 *
 * Emits one structured log entry per request on the `onResponse` hook so that
 * method, path, status, latency (ms), and request ID are always captured
 * together. A lighter "incoming" entry is also emitted on `onRequest` for
 * early visibility (e.g. long-running requests that never complete).
 *
 * Sensitive headers and request/response bodies are never logged.
 * All log objects are machine-parseable JSON (no free-form strings as values).
 */
async function logger(fastify: FastifyInstance) {
  // Lightweight "incoming" entry — no body, no sensitive headers.
  fastify.addHook("onRequest", async (request: FastifyRequest) => {
    const userAddress =
      (request.params as Record<string, string> | undefined)?.address ||
      (request.headers["x-user-address"] as string | undefined) ||
      (request.headers["x-address"] as string | undefined);

    request.log.info(
      {
        type: "request",
        requestId: request.id,
        method: request.method,
        path: request.url,
        ...(userAddress ? { userAddress } : {}),
      },
      "incoming request"
    );
  });

  // Full access-log entry emitted once the response is sent.
  fastify.addHook(
    "onResponse",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const statusCode = reply.statusCode;
      // elapsedTime is in milliseconds (float) — keep as number for machine parsing.
      const durationMs = Math.round(reply.elapsedTime);

      const level: "info" | "warn" | "error" =
        statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";

      request.log[level](
        {
          type: "response",
          requestId: request.id,
          method: request.method,
          path: request.url,
          statusCode,
          durationMs,
        },
        "request completed"
      );
    }
  );
}

export const requestLogger = fp(logger);
