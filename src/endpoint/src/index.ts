/**
 * Main application entry point
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "./api/routes";
import { OrderController } from "./interfaces/services";

// TODO: Import actual implementations when they're created
// import { OrderControllerImpl } from './services/OrderController';

export async function buildApp() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
    },
  });

  // Register CORS
  await fastify.register(cors, {
    origin: true,
  });

  // TODO: Initialize services and dependencies
  // const orderController: OrderController = new OrderControllerImpl();

  // For now, create a placeholder controller
  const orderController: OrderController = {
    async submitOrder() {
      throw new Error("OrderController not yet implemented");
    },
  };

  // Register routes
  await fastify.register(registerRoutes, {
    orderController,
  });

  return fastify;
}

export async function start() {
  try {
    const app = await buildApp();
    const port = parseInt(process.env.PORT || "3000", 10);
    const host = process.env.HOST || "0.0.0.0";

    await app.listen({ port, host });
    console.log(`Server listening on ${host}:${port}`);
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

// Start the server if this file is run directly
if (require.main === module) {
  start();
}
