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
import { redis } from "./services/redis.js";

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
    checkRedis: async () => {
      const ok = await redis.healthCheck();
      if (!ok) throw new Error("Redis PING did not return PONG");
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

  // Apply rate limiting globally, but exclude readiness/health probes
  // K8s readiness probes (GET /v1/ready) must not be rate-limited or
  // blocked by authentication so the cluster can determine service health
  server.addHook("onRequest", (request, reply, done) => {
    const isHealthProbe =
      request.url === "/v1/ready" || request.url === "/v1/health";
    if (isHealthProbe) {
      done();
    } else {
      rateLimiter(request, reply, done);
    }
  });

  // Register API routes under /v1
  server.register(
    async (v1) => {
      // Guard: any plugin within this scope must not hardcode a /v1 prefix on
      // its own routes — the parent scope already adds it, which would produce
      // double-prefixed paths like /v1/v1/markets.
      v1.addHook("onRoute", (routeOptions) => {
        if (routeOptions.url.startsWith("/v1")) {
          throw new Error(
            `Plugin registered route "${routeOptions.url}" with a /v1 prefix ` +
              `inside the /v1-scoped block — remove the prefix from the plugin.`
          );
        }
      });

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

  // Serve interactive API documentation at /docs using Swagger UI (CDN-hosted).
  // The spec is loaded from /v1/openapi.json at runtime so it stays in sync.
  server.get("/docs", async (_request, reply) => {
    const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vatix API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({
        url: "/v1/openapi.json",
        dom_id: "#swagger-ui",
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout: "BaseLayout",
        deepLinking: true,
      });
    </script>
  </body>
</html>`;
    return reply.type("text/html").send(html);
  });

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
  // Disable test routes in production
  const registerTestRoutes = config.nodeEnv !== "production";
  const server = buildServer({ registerTestRoutes });

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

    // Graceful shutdown handling
    const SHUTDOWN_TIMEOUT_MS = 30_000; // 30 seconds
    let isShuttingDown = false;

    const gracefulShutdown = async (signal: string) => {
      if (isShuttingDown) {
        return;
      }
      isShuttingDown = true;

      server.log.info(
        {
          signal,
          component: "api-server",
          status: "initiated",
        },
        "API server shutdown initiated"
      );

      // Set hard timeout to force exit if shutdown hangs
      const timeoutHandle = setTimeout(() => {
        server.log.error(
          {
            signal,
            component: "api-server",
            timeoutMs: SHUTDOWN_TIMEOUT_MS,
          },
          "Shutdown timeout exceeded, forcing exit"
        );
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);

      try {
        // Close server — stops accepting new connections, drains in-flight requests
        await server.close();
        clearTimeout(timeoutHandle);

        server.log.info(
          {
            signal,
            component: "api-server",
            status: "complete",
            exitCode: 0,
          },
          "API server shutdown complete"
        );
        process.exit(0);
      } catch (error) {
        clearTimeout(timeoutHandle);
        server.log.error(
          {
            signal,
            component: "api-server",
            status: "failed",
            exitCode: 1,
            error: error instanceof Error ? error.message : String(error),
          },
          "API server shutdown failed"
        );
        process.exit(1);
      }
    };

    // Register signal handlers for graceful shutdown
    process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
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
