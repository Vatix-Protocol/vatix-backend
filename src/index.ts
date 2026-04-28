import Fastify from "fastify";
import { errorHandler } from "./api/middleware/errorHandler.js";
import positionsRouter from "./api/routes/positions.js";
import { NotFoundError, ValidationError } from "./api/middleware/errors.js";
import { signingService } from "./services/signing.js";
import "dotenv/config";
import { marketsRoutes } from "./api/routes/markets.js";
import { ordersRoutes } from "./api/routes/orders.js";
import { adminRoutes } from "./api/routes/admin.js";
import { rateLimiter } from "./api/middleware/rateLimiter.js";
import { requestLogger } from "./api/middleware/logger.js";
import { requestIdMiddleware } from "./api/middleware/requestId.js";
import { corsPlugin } from "./api/middleware/cors.js";

// Default: 64 KB. Override via BODY_LIMIT_BYTES env var.
// Oversized requests are rejected with 413 Request Entity Too Large.
const bodyLimit = Number(process.env.BODY_LIMIT_BYTES) || 65_536;

const server = Fastify({
  logger: true,
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

// Register API routes
server.register(marketsRoutes);
server.register(ordersRoutes);

server.register(positionsRouter);
server.register(adminRoutes);

server.get("/health", async () => {
  return { status: "ok", service: "vatix-backend" };
});

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

// Global 404 handler — must be registered after all routes
// Throws through the error handler for consistent response format
server.setNotFoundHandler((request, reply) => {
  const requestId = request.id;
  reply.status(404).send({
    error: `Route ${request.method} ${request.url} not found`,
    requestId,
    statusCode: 404,
  });
});

const start = async () => {
  try {
    // Initialize signing service BEFORE starting server
    signingService.initialize();

    const port = Number(process.env.PORT) || 3000;
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

start();
