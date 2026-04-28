import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { isSensitiveKey } from "../../packages/shared/src/logRedactor.js";

/**
 * Returns true when a header name is considered sensitive and must be
 * excluded from log output. Combines a hard-coded set of well-known HTTP
 * auth/cookie headers with the shared isSensitiveKey registry so that any
 * newly registered sensitive key is automatically covered here too.
 */
function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "authorization" ||
    lower === "cookie" ||
    lower === "set-cookie" ||
    lower === "x-api-key" ||
    lower === "x-auth-token" ||
    isSensitiveKey(lower)
  );
}

// Re-export for use in tests
export { isSensitiveHeader };

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
