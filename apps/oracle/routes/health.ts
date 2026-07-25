import type { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../../src/services/prisma.js";

interface HealthResponse {
  status: "ok" | "degraded";
  service: string;
  uptime: number;
  timestamp: string;
  dependencies: {
    database: "ok" | "error";
  };
}

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get<{ Reply: HealthResponse }>("/health", async (_request, reply) => {
    let dbStatus: "ok" | "error" = "ok";

    try {
      const prisma = getPrismaClient();
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = "error";
    }

    const status = dbStatus === "ok" ? "ok" : "degraded";

    return reply.status(200).send({
      status,
      service: "vatix-oracle",
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      dependencies: {
        database: dbStatus,
      },
    });
  });
}
