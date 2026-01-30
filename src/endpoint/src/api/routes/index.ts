/**
 * API routes index
 */

import { FastifyInstance } from "fastify";
import { orderRoutes, OrderRouteOptions } from "./orders";

export interface RouteOptions {
  orderController: OrderRouteOptions["orderController"];
}

export async function registerRoutes(
  fastify: FastifyInstance,
  options: RouteOptions,
) {
  // Register order routes
  await fastify.register(orderRoutes, {
    orderController: options.orderController,
  });
}
