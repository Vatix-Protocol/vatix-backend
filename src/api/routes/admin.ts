import type { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import { requireAdmin } from "../middleware/adminGuard.js";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import { MarketNotFoundError } from "../middleware/errors.js";
import { adminLimiter } from "../middleware/rateLimiter.js";
import { success } from "../middleware/responses.js";

export async function adminRoutes(fastify: FastifyInstance) {
  const prisma = getPrismaClient();

  // All routes in this plugin require API key, admin role, and the admin rate limit tier.
  fastify.addHook("onRequest", adminLimiter);
  fastify.addHook("onRequest", requireApiKey);
  fastify.addHook("onRequest", requireAdmin);

  // GET /admin/markets - list all markets including cancelled
  fastify.get("/admin/markets", async (_request, reply) => {
    const markets = await prisma.market.findMany({
      orderBy: { createdAt: "desc" },
    });
    success(reply, { markets, count: markets.length });
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

      const existing = await prisma.market.findUnique({ where: { id } });
      if (!existing) {
        throw new MarketNotFoundError(id);
      }

      const market = await prisma.market.update({
        where: { id },
        data: { status: status as any },
      });

      success(reply, { market });
    }
  );
}
