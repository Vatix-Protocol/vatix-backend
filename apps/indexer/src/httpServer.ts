import fastify, { type FastifyInstance } from "fastify";
import { indexerCorsPlugin } from "./middleware/cors.js";
import { marketsRoutes } from "./routes/markets.js";

/**
 * Builds the indexer's read-only HTTP surface (GET /markets, /markets/:id).
 *
 * indexerCorsPlugin is registered before any route so no path is ever
 * reachable without going through the shared origin-allowlist policy
 * (packages/shared/src/cors.ts) first — in NODE_ENV=production an unset
 * CORS_ALLOWED_ORIGINS resolves to a deny-all list rather than an open one
 * (#775), so a misconfigured deploy fails closed instead of silently
 * exposing markets data to any origin.
 *
 * Not started automatically: apps/indexer/src/main.ts only calls this when
 * INDEXER_HTTP_ENABLED=true, so the indexer's default off-chain
 * event-ingestion role stays HTTP-free unless an operator explicitly opts
 * in — see docs/docker-compose.md and docs/architecture.md.
 */
export async function buildIndexerHttpServer(): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  await app.register(indexerCorsPlugin);
  await app.register(marketsRoutes);
  return app;
}
