import { randomBytes } from "crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
  ValidationError,
} from "../middleware/errors.js";
import { adminLimiter } from "../middleware/rateLimiter.js";
import { success } from "../middleware/responses.js";
import { computeMarketEtag } from "./market.dto.js";
import { BreakGlassService } from "../../services/break-glass.js";
import { createLogger } from "../../../apps/indexer/src/logger.js";

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

  // POST /admin/markets/:id/break-glass/halt - Initiate market halt
  // Step 1: First admin initiates, gets an approval token
  // Step 2: Second admin uses token to execute
  fastify.post<{
    Params: { id: string };
    Body: { reason?: string };
    Headers: { "x-approval-token"?: string };
  }>(
    "/admin/markets/:id/break-glass/halt",
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
            reason: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: marketId } = request.params;
      const { reason } = request.body;
      const approvalToken = request.headers["x-approval-token"];
      const actor = (request as any).adminKey || "unknown";
      const requestId = randomBytes(16).toString("hex");

      const breakGlass = new BreakGlassService(
        prisma,
        createLogger(process.env.LOG_LEVEL as any)
      );

      // If approval token provided, execute the halt
      if (approvalToken) {
        const result = await breakGlass.executeWithApproval(
          {
            marketId,
            action: "halt",
            actor,
            requestId,
            reason,
            approvalToken,
          },
          actor
        );
        success(reply, result);
      } else {
        // Otherwise, initiate approval request
        const approval = await breakGlass.initiateApproval({
          marketId,
          action: "halt",
          initiator: actor,
          requestId,
          reason,
        });
        reply.status(202).send({
          status: "approval_required",
          requestId: approval.requestId,
          token: approval.token,
          expiresAt: approval.expiresAt.toISOString(),
          message: "Second admin approval required. Use token in X-Approval-Token header.",
        });
      }
    }
  );

  // POST /admin/markets/:id/break-glass/cancel-all - Initiate cancel all orders
  fastify.post<{
    Params: { id: string };
    Body: { reason?: string };
    Headers: { "x-approval-token"?: string };
  }>(
    "/admin/markets/:id/break-glass/cancel-all",
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
            reason: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: marketId } = request.params;
      const { reason } = request.body;
      const approvalToken = request.headers["x-approval-token"];
      const actor = (request as any).adminKey || "unknown";
      const requestId = randomBytes(16).toString("hex");

      const breakGlass = new BreakGlassService(
        prisma,
        createLogger(process.env.LOG_LEVEL as any)
      );

      if (approvalToken) {
        const result = await breakGlass.executeWithApproval(
          {
            marketId,
            action: "cancel-all",
            actor,
            requestId,
            reason,
            approvalToken,
          },
          actor
        );
        success(reply, result);
      } else {
        const approval = await breakGlass.initiateApproval({
          marketId,
          action: "cancel-all",
          initiator: actor,
          requestId,
          reason,
        });
        reply.status(202).send({
          status: "approval_required",
          requestId: approval.requestId,
          token: approval.token,
          expiresAt: approval.expiresAt.toISOString(),
          message: "Second admin approval required. Use token in X-Approval-Token header.",
        });
      }
    }
  );

  // POST /admin/markets/:id/break-glass/resume - Resume a halted market
  fastify.post<{
    Params: { id: string };
    Body: { reason?: string };
    Headers: { "x-approval-token"?: string };
  }>(
    "/admin/markets/:id/break-glass/resume",
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
            reason: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: marketId } = request.params;
      const { reason } = request.body;
      const approvalToken = request.headers["x-approval-token"];
      const actor = (request as any).adminKey || "unknown";
      const requestId = randomBytes(16).toString("hex");

      const breakGlass = new BreakGlassService(
        prisma,
        createLogger(process.env.LOG_LEVEL as any)
      );

      if (approvalToken) {
        const result = await breakGlass.executeWithApproval(
          {
            marketId,
            action: "resume",
            actor,
            requestId,
            reason,
            approvalToken,
          },
          actor
        );
        success(reply, result);
      } else {
        const approval = await breakGlass.initiateApproval({
          marketId,
          action: "resume",
          initiator: actor,
          requestId,
          reason,
        });
        reply.status(202).send({
          status: "approval_required",
          requestId: approval.requestId,
          token: approval.token,
          expiresAt: approval.expiresAt.toISOString(),
          message: "Second admin approval required. Use token in X-Approval-Token header.",
        });
      }
    }
  );

  // GET /admin/markets/:id/break-glass/audit - View break-glass audit log
  fastify.get<{ Params: { id: string } }>(
    "/admin/markets/:id/break-glass/audit",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { id: marketId } = request.params;

      const breakGlass = new BreakGlassService(
        prisma,
        createLogger(process.env.LOG_LEVEL as any)
      );

      const auditLog = await breakGlass.getAuditLog(marketId);
      success(reply, {
        marketId,
        actions: auditLog.map((action) => ({
          id: action.id,
          action: action.action,
          actor: action.actor,
          beforeStatus: action.beforeStatus,
          afterStatus: action.afterStatus,
          ordersCancelled: action.ordersCancelled,
          collateralReleased: action.collateralReleased.toString(),
          reason: action.reason,
          createdAt: action.createdAt.toISOString(),
        })),
      });
    }
  );
}
