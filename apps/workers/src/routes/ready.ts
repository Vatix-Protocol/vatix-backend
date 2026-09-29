import type { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../../../src/services/prisma.js";
import { redis } from "../../../../src/services/redis.js";
import {
  classifyProbeError,
  sanitizeProbeMessage,
  type ProbeErrorCode,
} from "../../../../packages/shared/src/probeErrors.js";

interface DependencyReport {
  status: "ok" | "error";
  /**
   * Secret-free failure summary. This route is unauthenticated, so the
   * driver's raw message is never published — a Prisma/ioredis error can
   * embed the full DSN or an internal host:port (#1141). The unsanitized
   * message is written to the request log only.
   */
  error?: string;
  /** Stable, secret-free classification for dashboards and alerts. */
  code?: ProbeErrorCode;
}

interface ReadyResponse {
  ready: boolean;
  service: string;
  timestamp: string;
  dependencies: {
    database: DependencyReport;
    redis: DependencyReport;
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
    let dbCode: ProbeErrorCode | undefined;
    // Raw driver messages stay server-side: they go to the log, never the reply.
    let rawDbError: string | undefined;
    let rawRedisError: string | undefined;

    try {
      const prisma = getPrismaClient();
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      dbStatus = "error";
      dbCode = classifyProbeError(err);
      dbError = sanitizeProbeMessage(err);
      rawDbError = err instanceof Error ? err.message : String(err);
    }

    let redisStatus: "ok" | "error" = "ok";
    let redisError: string | undefined;
    let redisCode: ProbeErrorCode | undefined;

    try {
      const pong = await redis.healthCheck();
      if (!pong) {
        throw new Error("Redis PING did not return PONG");
      }
    } catch (err) {
      redisStatus = "error";
      redisCode = classifyProbeError(err);
      redisError = sanitizeProbeMessage(err);
      rawRedisError = err instanceof Error ? err.message : String(err);
    }

    const ready = dbStatus === "ok" && redisStatus === "ok";

    if (!ready) {
      // Server-side only. The raw messages are useful for on-call debugging
      // and are never reachable by an unauthenticated probe client.
      request.log.warn(
        {
          requestId,
          dbStatus,
          redisStatus,
          ...(dbCode ? { dbCode } : {}),
          ...(redisCode ? { redisCode } : {}),
          ...(rawDbError ? { dbError: rawDbError } : {}),
          ...(rawRedisError ? { redisError: rawRedisError } : {}),
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
          ...(dbCode ? { code: dbCode } : {}),
          ...(dbError ? { error: dbError } : {}),
        },
        redis: {
          status: redisStatus,
          ...(redisCode ? { code: redisCode } : {}),
          ...(redisError ? { error: redisError } : {}),
        },
      },
    });
  });
}
