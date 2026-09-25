import type { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../../src/services/prisma.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";

/** Stable error codes for indexer market routes. */
export type MarketErrorCode =
  | "MARKET_NOT_FOUND"
  | "MARKET_QUERY_FAILED"
  | "UNAUTHORIZED";

/**
 * Registers read-only market routes on the indexer HTTP surface.
 * These routes are protected by CORS (indexerCorsPlugin) and the
 * rate-limit/authz onRequest hook registered by buildIndexerHttpServer.
 */
export async function marketsRoutes(app: FastifyInstance): Promise<void> {
  const logger = app.log as ILogger;

  app.get("/markets", async (request, reply) => {
    const correlationId =
      (request.headers["x-correlation-id"] as string | undefined) ??
      request.id;

    try {
      const prisma = getPrismaClient();
      const markets = await prisma.market.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          question: true,
          endTime: true,
          resolutionTime: true,
          oracleAddress: true,
          status: true,
          outcome: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });

      logger.debug(
        { correlationId, count: markets.length },
        "markets list served"
      );

      return reply.send({
        success: true,
        data: markets,
        requestId: correlationId,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error(
        { correlationId, err: err instanceof Error ? err.message : "unknown" },
        "markets query failed"
      );
      return reply.code(500).send({
        error: "Market query failed",
        code: "MARKET_QUERY_FAILED" satisfies MarketErrorCode,
        correlationId,
      });
    }
  });

  app.get("/markets/:id", async (request, reply) => {
    const correlationId =
      (request.headers["x-correlation-id"] as string | undefined) ??
      request.id;
    const { id } = request.params as { id: string };

    try {
      const prisma = getPrismaClient();
      const market = await prisma.market.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          question: true,
          endTime: true,
          resolutionTime: true,
          oracleAddress: true,
          status: true,
          outcome: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!market) {
        return reply.code(404).send({
          error: "Market not found",
          code: "MARKET_NOT_FOUND" satisfies MarketErrorCode,
          correlationId,
        });
      }

      logger.debug(
        { correlationId, marketId: id },
        "market served"
      );

      return reply.send({
        success: true,
        data: market,
        requestId: correlationId,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error(
        { correlationId, marketId: id, err: err instanceof Error ? err.message : "unknown" },
        "market query failed"
      );
      return reply.code(500).send({
        error: "Market query failed",
        code: "MARKET_QUERY_FAILED" satisfies MarketErrorCode,
        correlationId,
      });
    }
  });
}
