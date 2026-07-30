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
import { fillsRoutes } from "./api/routes/fills.js";
import { adminRoutes } from "./api/routes/admin.js";
import { authRoutes } from "./api/routes/auth.js";
import { healthRoutes } from "./api/routes/health.js";
import { readyRoute } from "./api/routes/ready.js";
import { metricsRoutes } from "./api/routes/metrics.js";
import { createReadyDeps } from "./api/deps/ready-deps.js";
import { registerDeprecatedAliases } from "./api/routes/legacy.js";
import { getOpenApiSpec } from "./api/openapi.js";
import { rateLimiter } from "./api/middleware/rateLimiter.js";
import { requestLogger } from "./api/middleware/logger.js";
import {
  makeGenReqId,
  requestIdMiddleware,
} from "./api/middleware/requestId.js";
import { config } from "./config.js";
import { parseApiEnv } from "./env.js";
import { corsPlugin } from "./api/middleware/cors.js";
import { redis } from "./services/redis.js";
import { walletRoutes } from "./api/routes/wallet.js";
import { admissionControl } from "./api/middleware/admissionControl.js";

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
    // Name the auto-bound pino field "requestId" so every request.log.*
    // call carries it — not just the ones in requestLogger.
    requestIdLogLabel: "requestId",
    // Accept a valid incoming UUID from x-request-id before pino creates the
    // child logger, so the binding is correct from the very first log entry.
    genReqId: makeGenReqId(),
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
      request.url === "/v1/ready" ||
      request.url === "/v1/health" ||
      request.url === "/metrics";
    if (isHealthProbe) {
      done();
    } else {
      rateLimiter(request, reply, done);
    }
  });

  // Apply admission control (load shedding) based on downstream lag
  // Skips health/ready probes and admin operations
  server.addHook("onRequest", async (request, reply) => {
    const isHealthProbe =
      request.url === "/v1/ready" ||
      request.url === "/v1/health" ||
      request.url === "/metrics";
    if (!isHealthProbe) {
      await admissionControl(request, reply);
    }
  });

  // Register API routes under /v1
  server.register(
    async (v1) => {
      // Guard: any plugin within this scope must not hardcode a /v1 prefix on
      // its own routes — the parent scope already adds it, which would produce
      // double-prefixed paths like /v1/v1/markets.
      v1.addHook("onRoute", (routeOptions) => {
        if (routeOptions.url.startsWith("/v1/v1")) {
          throw new Error(
            `Plugin registered route "${routeOptions.url}" with a /v1 prefix ` +
              `inside the /v1-scoped block — remove the prefix from the plugin.`
          );
        }
      });

      await v1.register(marketsRoutes);
      await v1.register(ordersRoutes);
      await v1.register(positionsRouter);
      await v1.register(fillsRoutes);
      await v1.register(adminRoutes);
      await v1.register(authRoutes);
      await v1.register(healthRoutes);
      await v1.register(readyRoute(options.readyDeps ?? createReadyDeps()));

      v1.get("/openapi.json", async (_request, reply) => {
        const nodeEnv = process.env.NODE_ENV || "development";
        return reply.status(200).send(getOpenApiSpec(nodeEnv));
      });
    },
    { prefix: "/v1" }
  );

  registerDeprecatedAliases(server);

  // walletRoutes hardcodes its own /v1 prefix internally, so it must be
  // registered outside the /v1-scoped block above (the onRoute guard there
  // rejects routes that already start with /v1 to prevent /v1/v1 double-prefixing).
  server.register(walletRoutes);

  // Prometheus scrape endpoint, unversioned and unauthenticated by convention
  // (restrict network access to it at the infra/ingress layer).
  server.register(metricsRoutes);

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

  // Gate test routes behind option and NODE_ENV !== "production"
  const enableTestRoutes =
    options.registerTestRoutes !== false &&
    (process.env.NODE_ENV || "development") !== "production";
  if (enableTestRoutes) {
    server.log.warn(
      "Test routes (/test/*) are enabled. Do not enable in production!"
    );

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
  // Fail fast on invalid env before binding routes or opening connections.
  parseApiEnv();

  // Disable test routes in production
  const registerTestRoutes = config.nodeEnv !== "production";
  const server = buildServer({ registerTestRoutes });

  // Set up global handlers for unhandled rejections and exceptions
  // These handlers ensure all unhandled errors are logged and the process exits gracefully
  process.on(
    "unhandledRejection",
    (reason: unknown, promise: Promise<unknown>) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      server.log.error(
        { reason: message, stack, promise: String(promise) },
        "Unhandled promise rejection"
      );
      // Exit with error code after logging
      process.exit(1);
    }
  );

  process.on("uncaughtException", (error: Error) => {
    server.log.error(
      { error: error.message, stack: error.stack },
      "Uncaught exception"
    );
    // Exit with error code after logging
    process.exit(1);
  });

  try {
    // Initialize signing service BEFORE starting server
    signingService.initialize();

    // Hydrate in-memory order books from Postgres on cold start (#449).
    // This eliminates the race window where a restart leaves books empty
    // while open orders still exist in the database.
    const { matchingService, isMatchingEngineEnabled } =
      await import("./matching/matching-service.js");

    if (isMatchingEngineEnabled()) {
      // Single-writer enforcement: only the Redis lease holder may match
      // orders (see src/matching/leader-lease.ts). Hydration only makes
      // sense once this instance actually holds the lease — a standby
      // instance has nothing useful to warm since placeOrder() will reject
      // until it becomes leader. The first acquisition attempt below is
      // awaited so a pod that wins the lease on boot serves warm books from
      // its very first request; a pod that loses the race still comes up
      // and serves health/read traffic while it retries in the background.
      const { leaderLease } = await import("./matching/leader-lease.js");
      await leaderLease.start({
        onAcquired: () => matchingService.hydrateAllActiveMarkets(),
        onLost: () => matchingService.invalidateAllBooks(),
      });
    }

    const port = config.port;
    await server.listen({ port, host: "0.0.0.0" });
    server.log.info(
      { nodeEnv: config.nodeEnv, port },
      `Server running at http://localhost:${port}`
    );

    // Graceful shutdown handling
    const VALID_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    type ShutdownSignal = (typeof VALID_SHUTDOWN_SIGNALS)[number];

    const SHUTDOWN_TIMEOUT_MS = 30_000; // 30 seconds
    let isShuttingDown = false;

    const shutdown = async (signal: ShutdownSignal) => {
      if (
        typeof signal !== "string" ||
        signal.trim() === "" ||
        !VALID_SHUTDOWN_SIGNALS.includes(
          signal as (typeof VALID_SHUTDOWN_SIGNALS)[number]
        )
      ) {
        server.log.warn(
          {
            signal,
            statusCode: 400,
            component: "api-server",
            validSignals: [...VALID_SHUTDOWN_SIGNALS],
          },
          "Graceful shutdown called with invalid signal"
        );
        return;
      }

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

        // Gracefully disconnect database and redis, and release the
        // matching leader lease (if held) so the next holder doesn't wait
        // out the full lease TTL before taking over.
        const { disconnectPrisma } = await import("./services/prisma.js");
        const { disconnectAnalyticsPrisma } =
          await import("./services/analytics-prisma.js");
        const { redis } = await import("./services/redis.js");
        const { leaderLease } = await import("./matching/leader-lease.js");
        await leaderLease.release();
        await Promise.allSettled([
          disconnectPrisma(),
          disconnectAnalyticsPrisma(),
          redis.disconnect(),
        ]);

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
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGHUP", () => void shutdown("SIGHUP"));
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
