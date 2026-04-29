import Fastify, { type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { readyRoute } from "./api/routes/ready.js";

const server: FastifyInstance = Fastify({
  logger: true,
});

const prisma = new PrismaClient();

/**
 * All public API routes are registered under the /v1 prefix.
 *
 * Non-versioned paths (e.g. GET /health) are not registered and will
 * receive Fastify's default 404 response.
 *
 * To add new routes, register them inside this plugin so they
 * automatically inherit the /v1 prefix.
 */
server.register(
  async (v1) => {
    /**
     * GET /v1/health — Liveness probe.
     * Confirms the HTTP server is alive. No dependency checks.
     */
    v1.get("/health", async () => {
      return { status: "ok", service: "vatix-backend" };
    });
  },
  { prefix: "/v1" }
);

/**
 * GET /v1/ready — Readiness probe.
 * Checks DB connectivity and index freshness before reporting ready.
 */
server.register(
  readyRoute({
    checkDatabase: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
    getLastIndexedAt: async () => {
      // Query the most recent indexed event timestamp from the DB.
      // Returns null when no events have been indexed yet.
      const result = await prisma.$queryRaw<{ last_indexed_at: Date | null }[]>`
        SELECT MAX("createdAt") AS last_indexed_at FROM "Market"
      `;
      const ts = result[0]?.last_indexed_at;
      return ts ? ts.getTime() : null;
    },
  }),
  { prefix: "/v1" }
);

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await server.listen({ port, host: "0.0.0.0" });
    console.log(`Server running at http://localhost:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
