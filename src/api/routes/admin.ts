import type { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import {
  getAnalyticsPrismaClient,
  isAnalyticsDatabaseConfigured,
} from "../../services/analytics-prisma.js";
import { requireAdmin } from "../middleware/adminGuard.js";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import {
  MarketNotFoundError,
  PreconditionFailedError,
} from "../middleware/errors.js";
import { adminLimiter } from "../middleware/rateLimiter.js";
import { success } from "../middleware/responses.js";
import { computeMarketEtag } from "./market.dto.js";

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

  // GET /admin/analytics/summary - aggregate reporting stats (#743).
  // Reads from the analytics (read-only) database connection so heavy
  // aggregate queries don't compete with primary OLTP traffic. Falls back
  // to the primary connection when ANALYTICS_DATABASE_URL is unset.
  fastify.get("/admin/analytics/summary", async (_request, reply) => {
    const analyticsPrisma = getAnalyticsPrismaClient();

    const [marketsByStatus, totalTrades, tradeVolume] = await Promise.all([
      analyticsPrisma.market.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      analyticsPrisma.trade.count(),
      analyticsPrisma.trade.aggregate({ _sum: { quantity: true } }),
    ]);

    success(reply, {
      source: isAnalyticsDatabaseConfigured() ? "replica" : "primary",
      marketsByStatus: Object.fromEntries(
        marketsByStatus.map((row) => [row.status, row._count._all])
      ),
      totalTrades,
      totalTradedQuantity: tradeVolume._sum.quantity ?? 0,
    });
  });

  // PATCH /admin/markets/:id/status - update market status
  // Supports optimistic concurrency via the If-Match header: when present,
  // it must match the market's current ETag (as returned by GET /markets/:id)
  // or the update is rejected with 412 Precondition Failed.
  fastify.patch<{
    Params: { id: string };
    Body: { status: string };
    Headers: { "if-match"?: string };
  }>(
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
      const ifMatch = request.headers["if-match"];

      const existing = await prisma.market.findUnique({ where: { id } });
      if (!existing) {
        throw new MarketNotFoundError(id);
      }

      if (
        ifMatch &&
        ifMatch !== "*" &&
        ifMatch !== computeMarketEtag(existing)
      ) {
        throw new PreconditionFailedError();
      }

      const market = await prisma.market.update({
        where: { id },
        data: { status: status as any },
      });

      reply.header("etag", computeMarketEtag(market));
      success(reply, { market });
    }
  );
}
