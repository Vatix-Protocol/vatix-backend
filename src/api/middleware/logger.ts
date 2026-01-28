import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";

/**
 * Request logging middleware for Fastify.
 * Tracks incoming requests and outgoing responses with duration and status codes.
 */
async function logger(fastify: FastifyInstance) {
  // Add Request ID to response headers as early as possible
  fastify.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-ID", request.id);
  });

  // Log incoming request details
  fastify.addHook("onRequest", async (request: FastifyRequest) => {
    const { method, url, query, params, body } = request;

    // Check for user address in params, body, or headers
    // Note: 'params' and 'body' might not be fully parsed yet depending on the hook
    // but in 'onRequest' params are usually available if it's a standard route.
    // However, body is parsed later. 'preHandler' might be better for body.
    const userAddress =
      (params as any)?.address ||
      (body as any)?.userAddress ||
      request.headers["x-user-address"] ||
      request.headers["x-address"];

    request.log.info(
      {
        type: "request",
        method,
        url,
        query,
        userAddress,
      },
      `Incoming Request: ${method} ${url}`
    );
  });

  // Log response details and duration
  fastify.addHook(
    "onResponse",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const duration = reply.elapsedTime; // Fastify automatically tracks this
      const statusCode = reply.statusCode;

      let level: "info" | "warn" | "error" = "info";
      if (statusCode >= 500) {
        level = "error";
      } else if (statusCode >= 400) {
        level = "warn";
      }

      request.log[level](
        {
          type: "response",
          method: request.method,
          url: request.url,
          statusCode,
          duration: `${duration.toFixed(2)}ms`,
        },
        `Request Completed: ${request.method} ${request.url} - ${statusCode} (${duration.toFixed(
          2
        )}ms)`
      );
    }
  );
}

export const requestLogger = fp(logger);
