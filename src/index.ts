import Fastify from "fastify";
import { errorHandler } from "./api/middleware/errorHandler.js";
import positionsRouter from "./api/routes/positions.js";
import { NotFoundError, ValidationError } from "./api/middleware/errors.js";
import { signingService } from "./services/signing.js";
import "dotenv/config";
import { marketsRoutes } from "./api/routes/markets.js";
import { ordersRoutes } from "./api/routes/orders.js";

const server = Fastify({
  logger: true,
  genReqId: () => crypto.randomUUID(), // Generate unique request IDs
});

// Register error handler (must be before routes)
server.setErrorHandler(errorHandler);

// Register API routes
server.register(marketsRoutes);
server.register(ordersRoutes);

server.register(positionsRouter);

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


const start = async () => {
  try {
    // Initialize signing service BEFORE starting server
    signingService.initialize();

    const port = Number(process.env.PORT) || 3000;
    await server.listen({ port, host: "0.0.0.0" });
    console.log(`Server running at http://localhost:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
