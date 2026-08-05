import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import { auditService } from "../../services/audit.js";
import { ValidationError } from "../middleware/errors.js";

interface VerifyChainRequest {
  marketId: string;
  startTime?: string;
  endTime?: string;
}

interface ChainVerificationResponse {
  marketId: string;
  valid: boolean;
  totalEvents: number;
  mismatchCount: number;
  errors: Array<{ streamId: string; reason: string }>;
  verifiedAt: string;
}

/**
 * Admin API for audit trail verification.
 * Verifies hash chain integrity and detects tampering.
 */
export async function auditVerificationRoutes(fastify: FastifyInstance) {
  const prisma = getPrismaClient();

  /**
   * POST /audit/verify-chain — Verify hash chain integrity for a market
   * Admin-only endpoint (authentication required in production)
   */
  fastify.post<{ Body: VerifyChainRequest }>(
    "/audit/verify-chain",
    {
      schema: {
        body: {
          type: "object",
          required: ["marketId"],
          properties: {
            marketId: { type: "string" },
            startTime: { type: "string", format: "date-time" },
            endTime: { type: "string", format: "date-time" },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: VerifyChainRequest }>, reply) => {
      const { marketId, startTime, endTime } = request.body;

      if (!marketId) {
        throw new ValidationError("marketId is required");
      }

      // Verify market exists
      const market = await prisma.market.findUnique({
        where: { id: marketId },
      });

      if (!market) {
        throw new ValidationError("Market not found");
      }

      let startDate: Date | undefined;
      let endDate: Date | undefined;

      if (startTime) {
        startDate = new Date(startTime);
        if (isNaN(startDate.getTime())) {
          throw new ValidationError("Invalid startTime format");
        }
      }

      if (endTime) {
        endDate = new Date(endTime);
        if (isNaN(endDate.getTime())) {
          throw new ValidationError("Invalid endTime format");
        }
      }

      if (startDate && endDate && startDate > endDate) {
        throw new ValidationError("startTime must be before endTime");
      }

      const result = await auditService.verifyAuditChain(
        marketId,
        startDate,
        endDate
      );

      const response: ChainVerificationResponse = {
        marketId,
        valid: result.valid,
        totalEvents: result.totalEvents,
        mismatchCount: result.mismatchCount,
        errors: result.errors,
        verifiedAt: new Date().toISOString(),
      };

      reply.status(200).send(response);
    }
  );

  /**
   * GET /audit/watermark/:marketId — Get archival watermark for a market
   */
  fastify.get<{ Params: { marketId: string } }>(
    "/audit/watermark/:marketId",
    {
      schema: {
        params: {
          type: "object",
          required: ["marketId"],
          properties: {
            marketId: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { marketId: string } }>,
      reply
    ) => {
      const { marketId } = request.params;

      const watermark = await prisma.tradeStreamWatermark.findUnique({
        where: { marketId },
      });

      if (!watermark) {
        return reply.status(200).send({
          marketId,
          marketStreamId: null,
          globalStreamId: null,
          lastArchivedAt: null,
          archiveInitiatedAt: null,
        });
      }

      reply.status(200).send({
        marketId,
        marketStreamId: watermark.marketStreamId,
        globalStreamId: watermark.globalStreamId,
        lastArchivedAt: watermark.lastArchivedAt.toISOString(),
        archiveInitiatedAt: watermark.archiveInitiatedAt.toISOString(),
      });
    }
  );

  /**
   * GET /audit/events/:marketId — Get archived audit events for a market
   */
  fastify.get<{
    Params: { marketId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/audit/events/:marketId",
    {
      schema: {
        params: {
          type: "object",
          required: ["marketId"],
          properties: {
            marketId: { type: "string" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "string" },
            offset: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { marketId: string };
        Querystring: { limit?: string; offset?: string };
      }>,
      reply
    ) => {
      const { marketId } = request.params;
      const limit = Math.min(parseInt(request.query.limit ?? "100", 10), 1000);
      const offset = parseInt(request.query.offset ?? "0", 10);

      const events = await prisma.tradeAuditEvent.findMany({
        where: { marketId },
        orderBy: { archivedAt: "asc" },
        skip: offset,
        take: limit,
      });

      const total = await prisma.tradeAuditEvent.count({
        where: { marketId },
      });

      reply.status(200).send({
        marketId,
        events: events.map((e) => ({
          tradeId: e.tradeId,
          streamId: e.streamId,
          entryHash: e.entryHash,
          prevHash: e.prevHash,
          archivedAt: e.archivedAt.toISOString(),
        })),
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      });
    }
  );
}
