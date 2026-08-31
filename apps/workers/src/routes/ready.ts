import type { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../../../src/services/prisma.js";
import { redis } from "../../../../src/services/redis.js";

interface ReadyResponse {
  ready: boolean;
  service: string;
  timestamp: string;
  dependencies: {
    database: { status: "ok" | "error"; error?: string };
    redis: { status: "ok" | "error"; error?: string };
  };
}

/**
 * Readiness probe — checks that this worker instance can reach its
 * dependencies (database, Redis) and should therefore receive traffic /
 * be counted as available. This is deliberately separate from `/live`
 * (see live.ts): liveness must not depend on external services, or a
 * transient DB/Redis blip triggers pod restarts instead of a brief,
 * self-healing removal from rotation.
 */
export async function readyRoutes(fastify: FastifyInstance) {
  fastify.get<{ Reply: ReadyResponse }>("/ready", async (request, reply) => {
    const requestId =
      (request.headers["x-request-id"] as string | undefined) ?? request.id;
    reply.header("x-request-id", requestId);

    let dbStatus: "ok" | "error" = "ok";
    let dbError: string | undefined;

    try {
      const prisma = getPrismaClient();
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      dbStatus = "error";
      dbError = err instanceof Error ? err.message : String(err);
    }

    let redisStatus: "ok" | "error" = "ok";
    let redisError: string | undefined;

    try {
      const pong = await redis.healthCheck();
      if (!pong) {
        throw new Error("Redis PING did not return PONG");
      }
    } catch (err) {
      redisStatus = "error";
      redisError = err instanceof Error ? err.message : String(err);
    }

    const ready = dbStatus === "ok" && redisStatus === "ok";

    if (!ready) {
      // Log without secrets: dbError/redisError are driver error messages
      // (e.g. "connection refused"), never connection strings or credentials.
      request.log.warn(
        {
          requestId,
          dbStatus,
          redisStatus,
          ...(dbError ? { dbError } : {}),
          ...(redisError ? { redisError } : {}),
        },
        "Workers readiness check failed"
      );
    }

    return reply.status(ready ? 200 : 503).send({
      ready,
      service: "vatix-workers",
      timestamp: new Date().toISOString(),
      dependencies: {
        database: {
          status: dbStatus,
          ...(dbError ? { error: dbError } : {}),
        },
        redis: {
          status: redisStatus,
          ...(redisError ? { error: redisError } : {}),
        },
      },
    });
  });
}
