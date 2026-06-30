import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { IncomingMessage } from "node:http";
import fp from "fastify-plugin";

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns a genReqId function for Fastify that accepts a valid UUID from the
 * x-request-id request header, or falls back to the provided generator.
 * Exported so buildServer and tests share the same validation logic without
 * duplication.
 */
export function makeGenReqId(
  fallback: () => string = () => crypto.randomUUID()
): (req: IncomingMessage) => string {
  return (req: IncomingMessage) => {
    const id = (req.headers as Record<string, string | string[] | undefined>)[
      "x-request-id"
    ];
    return typeof id === "string" && UUID_REGEX.test(id) ? id : fallback();
  };
}

/**
 * Fastify plugin: echoes the resolved request ID back as the x-request-id
 * response header. The actual ID is set by buildServer's genReqId before any
 * hook runs, so this plugin only needs to write the response header.
 *
 * Register BEFORE the request logger so that the header is present by the
 * time the first log entry is emitted.
 */
async function requestIdPlugin(fastify: FastifyInstance) {
  fastify.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("x-request-id", request.id);
    }
  );
}

export const requestIdMiddleware = fp(requestIdPlugin);
