import type { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import {
  getAnalyticsPrismaClient,
  isAnalyticsDatabaseConfigured,
} from "../../services/analytics-prisma.js";
import { positionReconciliationService } from "../../services/position-reconciliation.js";
import { requireAdmin } from "../middleware/adminGuard.js";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import {
  MarketNotFoundError,
  PreconditionFailedError,
  ValidationError,
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

  // POST /admin/markets/:id/reconcile - on-demand position reconciliation
  fastify.post<{
    Params: { id: string };
    Body: { wallet?: string; autoRecovery?: boolean };
  }>(
    "/admin/markets/:id/reconcile",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          properties: {
            wallet: { type: "string" },
            autoRecovery: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: marketId } = request.params;
      const { wallet, autoRecovery } = request.body;

      const market = await prisma.market.findUnique({ where: { id: marketId } });
      if (!market) {
        throw new MarketNotFoundError(marketId);
      }

      if (wallet) {
        // Reconcile single wallet
        const result = await positionReconciliationService.reconcile(
          wallet,
          marketId,
          autoRecovery ?? false
        );
        success(reply, {
          marketId,
          wallet,
          hasDrift: result.hasDrift,
          divergence: result.divergence,
          recovered: result.recovered,
          recoveryReason: result.recoveryReason,
        });
      } else {
        // Reconcile entire market
        const result = await positionReconciliationService.reconcileMarket(
          marketId,
          autoRecovery ?? false
        );
        success(reply, {
          marketId,
          totalWallets: result.totalWallets,
          driftCount: result.driftCount,
          recoveredCount: result.recoveredCount,
          failedCount: result.failedCount,
          duration: result.duration,
        });
      }
    }
  );

  // GET /admin/markets/:id/reconciliation/status - view reconciliation history
  fastify.get<{
    Params: { id: string };
    Querystring: { wallet?: string; limit?: string; offset?: string };
  }>(
    "/admin/markets/:id/reconciliation/status",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            wallet: { type: "string" },
            limit: { type: "string" },
            offset: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: marketId } = request.params;
      const { wallet, limit: limitStr, offset: offsetStr } = request.query;

      const limit = Math.min(parseInt(limitStr ?? "100", 10), 1000);
      const offset = parseInt(offsetStr ?? "0", 10);

      const where: any = { marketId };
      if (wallet) {
        where.wallet = wallet;
      }

      const [jobs, total] = await Promise.all([
        prisma.positionReconciliationJob.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: offset,
          take: limit,
        }),
        prisma.positionReconciliationJob.count({ where }),
      ]);

      success(reply, {
        marketId,
        jobs: jobs.map((j) => ({
          id: j.id,
          wallet: j.wallet,
          driftDetected: j.driftDetected,
          recoveryApplied: j.recoveryApplied,
          recoveryReason: j.recoveryReason,
          createdAt: j.createdAt.toISOString(),
          completedAt: j.completedAt?.toISOString(),
        })),
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      });
    }
  );

  // GET /admin/markets/:id/deposits/reconciliation - view deposit reconciliation
  fastify.get<{
    Params: { id: string };
    Querystring: { wallet?: string; status?: string; limit?: string; offset?: string };
  }>(
    "/admin/markets/:id/deposits/reconciliation",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            wallet: { type: "string" },
            status: { type: "string" },
            limit: { type: "string" },
            offset: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: marketId } = request.params;
      const { wallet, status, limit: limitStr, offset: offsetStr } = request.query;

      const limit = Math.min(parseInt(limitStr ?? "100", 10), 1000);
      const offset = parseInt(offsetStr ?? "0", 10);

      const where: any = { marketId };
      if (wallet) {
        where.wallet = wallet;
      }
      if (status) {
        where.status = status;
      }

      const [reconciliations, total] = await Promise.all([
        prisma.depositReconciliation.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: offset,
          take: limit,
        }),
        prisma.depositReconciliation.count({ where }),
      ]);

      success(reply, {
        marketId,
        reconciliations: reconciliations.map((r) => ({
          id: r.id,
          depositId: r.depositId,
          wallet: r.wallet,
          amountRaw: r.amountRaw,
          status: r.status,
          reconciliationAttempts: r.reconciliationAttempts,
          appliedAt: r.appliedAt?.toISOString(),
          createdAt: r.createdAt.toISOString(),
        })),
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      });
    }
  );

  // POST /admin/markets/:id/reconciliation/recover - trigger recovery for detected drift
  fastify.post<{
    Params: { id: string };
    Body: { wallet?: string };
  }>(
    "/admin/markets/:id/reconciliation/recover",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          properties: {
            wallet: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: marketId } = request.params;
      const { wallet } = request.body;

      const market = await prisma.market.findUnique({ where: { id: marketId } });
      if (!market) {
        throw new MarketNotFoundError(marketId);
      }

      if (!wallet) {
        throw new ValidationError(
          "wallet is required for recovery operation"
        );
      }

      const result = await positionReconciliationService.reconcile(
        wallet,
        marketId,
        true // autoRecovery = true
      );

      success(reply, {
        marketId,
        wallet,
        hasDrift: result.hasDrift,
        recovered: result.recovered,
        recoveryReason: result.recoveryReason,
        divergence: result.divergence,
      });
    }
  );
}
