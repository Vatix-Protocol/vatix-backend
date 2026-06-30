import type { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../../../src/services/prisma.js";

interface ReadyResponse {
  ready: boolean;
  service: string;
  timestamp: string;
  dependencies: {
    database: { status: "ok" | "error"; error?: string };
  };
}

export async function readyRoutes(fastify: FastifyInstance) {
  fastify.get<{ Reply: ReadyResponse }>("/ready", async (_request, reply) => {
    let dbStatus: "ok" | "error" = "ok";
    let dbError: string | undefined;

    try {
      const prisma = getPrismaClient();
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      dbStatus = "error";
      dbError = err instanceof Error ? err.message : String(err);
    }

    const ready = dbStatus === "ok";

    return reply.status(ready ? 200 : 503).send({
      ready,
      service: "vatix-workers",
      timestamp: new Date().toISOString(),
      dependencies: {
        database: {
          status: dbStatus,
          ...(dbError ? { error: dbError } : {}),
        },
      },
    });
  });
}
