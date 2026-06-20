import Fastify, {
  type FastifyServerOptions,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import { pathToFileURL } from "node:url";
import { errorHandler } from "./api/middleware/errorHandler.js";
import positionsRouter from "./api/routes/positions.js";
import { NotFoundError, ValidationError } from "./api/middleware/errors.js";
import { signingService } from "./services/signing.js";
import "dotenv/config";
import { getPrismaClient } from "./services/prisma.js";
import { marketsRoutes } from "./api/routes/markets.js";
import { ordersRoutes } from "./api/routes/orders.js";
import { adminRoutes } from "./api/routes/admin.js";
import { healthRoutes } from "./api/routes/health.js";
import { readyRoute } from "./api/routes/ready.js";
import { registerDeprecatedAliases } from "./api/routes/legacy.js";
import { openApiSpec } from "./api/openapi.js";
import { rateLimiter } from "./api/middleware/rateLimiter.js";
import { requestLogger } from "./api/middleware/logger.js";
import { requestIdMiddleware } from "./api/middleware/requestId.js";
import { config } from "./config.js";
import { corsPlugin } from "./api/middleware/cors.js";

// Default: 64 KB. Override via BODY_LIMIT_BYTES env var.
// Oversized requests are rejected with 413 Request Entity Too Large.
const bodyLimit = Number(process.env.BODY_LIMIT_BYTES) || 65_536;

export interface BuildServerOptions {
  logger?: FastifyServerOptions["logger"];
  readyDeps?: Parameters<typeof readyRoute>[0];
  registerTestRoutes?: boolean;
}

function createDefaultReadyDeps(): Parameters<typeof readyRoute>[0] {
  return {
    checkDatabase: async () => {
      const prisma = getPrismaClient();
      await prisma.$queryRaw`SELECT 1`;
    },
    getLastIndexedAt: async () => {
      const prisma = getPrismaClient();
      const cursor = await prisma.indexerCursor.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      });
      return cursor ? cursor.updatedAt.getTime() : null;
    },
  };
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const server: FastifyInstance = Fastify({
    logger: options.logger ?? true,
    genReqId: () => crypto.randomUUID(), // Generate unique request IDs
    bodyLimit,
  });

  // Register error handler (must be before routes)
  server.setErrorHandler(errorHandler);

  // CORS — must be registered before routes so preflight OPTIONS requests are handled
  server.register(corsPlugin);

  // Resolve/generate request ID before anything else touches request.id
  server.register(requestIdMiddleware);

  // Register request logger (before routes so every request is captured)
  server.register(requestLogger);

  // Apply rate limiting globally
  server.addHook("onRequest", rateLimiter);

  // Register API routes under /v1
  server.register(
    async (v1) => {
      await v1.register(marketsRoutes);
      await v1.register(ordersRoutes);
      await v1.register(positionsRouter);
      await v1.register(adminRoutes);
      await v1.register(healthRoutes);
      await v1.register(
        readyRoute(options.readyDeps ?? createDefaultReadyDeps())
      );

      v1.get("/openapi.json", async (_request, reply) => {
        return reply.status(200).send(openApiSpec);
      });
    },
    { prefix: "/v1" }
  );

  registerDeprecatedAliases(server);

  if (options.registerTestRoutes !== false) {
    // Test routes for error handling
    server.get("/test/validation-error", async () => {
      throw new ValidationError("Invalid input data", {
        email: "Invalid email format",
        password: "Password must be at least 8 characters",
      });
    });

    server.get("/test/not-found", async () => {
      throw new NotFoundError("Market not found");
    });

    server.get("/test/server-error", async () => {
      throw new Error("Something went wrong internally");
    });
  }

  // Global 404 handler — must be registered after all routes
  // Throws through the error handler for consistent response format
  server.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    reply.status(404).send({
      error: `Route ${request.method} ${request.url} not found`,
      requestId,
      statusCode: 404,
    });
  });

  return server;
}

const start = async () => {
  const server = buildServer();

  try {
    // Initialize signing service BEFORE starting server
    signingService.initialize();

    // Hydrate in-memory order books from Postgres on cold start (#449).
    // This eliminates the race window where a restart leaves books empty
    // while open orders still exist in the database.
    const { matchingService } = await import("./matching/matching-service.js");
    await matchingService.hydrateAllActiveMarkets();

    const port = config.port;
    await server.listen({ port, host: "0.0.0.0" });
    server.log.info(
      { nodeEnv: config.nodeEnv, port },
      `Server running at http://localhost:${port}`
    );
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  start();
}
