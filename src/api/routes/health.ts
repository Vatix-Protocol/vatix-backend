import type { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";

interface HealthResponse {
  status: "ok" | "degraded";
  service: string;
  version: string;
  uptime: number;
  timestamp: string;
  dependencies: {
    database: "ok" | "error";
  };
}

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get<{ Reply: HealthResponse }>("/v1/health", async (_request, reply) => {
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
      service: "vatix-backend",
      version: process.env.npm_package_version ?? "unknown",
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      dependencies: {
        database: dbStatus,
      },
    });
  });
}
