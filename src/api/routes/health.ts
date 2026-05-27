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
  fastify.get<{ Reply: HealthResponse }>(
    "/v1/health",
    async (request, reply) => {
      let dbStatus: "ok" | "error" = "ok";

      try {
        const prisma = getPrismaClient();
        await prisma.$queryRaw`SELECT 1`;
      } catch {
        dbStatus = "error";
      }

      const status = dbStatus === "ok" ? "ok" : "degraded";
      const uptime = Math.floor(process.uptime());

      request.log[status === "ok" ? "debug" : "warn"](
        {
          route: "/v1/health",
          status,
          dependencies: {
            database: dbStatus,
          },
          uptime,
        },
        "Health check completed"
      );

      return reply.status(200).send({
        status,
        service: "vatix-backend",
        version: process.env.npm_package_version ?? "unknown",
        uptime,
        timestamp: new Date().toISOString(),
        dependencies: {
          database: dbStatus,
        },
      });
    }
  );
}
