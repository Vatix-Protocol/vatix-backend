import type { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import { requireAdmin } from "../middleware/adminGuard.js";
import { requireApiKey } from "../middleware/apiKeyAuth.js";

export async function adminRoutes(fastify: FastifyInstance) {
  const prisma = getPrismaClient();

  // All routes in this plugin require both API key and admin role
  fastify.addHook("onRequest", requireApiKey);
  fastify.addHook("onRequest", requireAdmin);

  // GET /admin/markets - list all markets including cancelled
  fastify.get("/admin/markets", async () => {
    const markets = await prisma.market.findMany({
      orderBy: { createdAt: "desc" },
    });
    return { markets, count: markets.length };
  });

  // PATCH /admin/markets/:id/status - update market status
  fastify.patch<{ Params: { id: string }; Body: { status: string } }>(
    "/admin/markets/:id/status",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["status"],
          properties: {
            status: {
              type: "string",
              enum: ["ACTIVE", "RESOLVED", "CANCELLED"],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { status } = request.body;

      const market = await prisma.market.update({
        where: { id },
        data: { status: status as any },
      });

      reply.code(200);
      return { market };
    }
  );
}
