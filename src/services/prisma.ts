import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "../config.js";

/**
 * Singleton Prisma Client instance
 * ensures only one database connection is created across the application
 */
let prismaInstance: PrismaClient | null = null;
let pgPool: Pool | null = null;

/**
 * get the singleton Prisma Client instance
 * creates a new instance if doesn't exist
 *
 * @returns {PrismaClient}
 */
export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    const isProduction = config.nodeEnv === "production";

    // create postgres connection pool — URL already validated at startup via config
    pgPool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolSize,
    });
    const adapter = new PrismaPg(pgPool);

    prismaInstance = new PrismaClient({
      adapter,
      log: isProduction
        ? ["error"] // production: only log errors
        : ["query", "error", "warn"], // development: log queries, errors, and warnings
    });
  }

  return prismaInstance;
}

/**
 * get the pg Pool instance for metrics
 *
 * @returns {Pool | null}
 */
export function getPool(): Pool | null {
  return pgPool;
}

/**
 * disconnect the Prisma Client instance
 * used for graceful shutdown and testing cleanup
 *
 * @returns {Promise<void>}
 */
export async function disconnectPrisma(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }

  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
}

// Note: this module intentionally does NOT register its own SIGINT/SIGTERM
// handlers. Every entrypoint that imports getPrismaClient()/disconnectPrisma()
// (the API server, indexer, oracle, and each worker) already owns a single
// graceful-shutdown sequence (via packages/shared/src/shutdown.ts or an
// equivalent local implementation) that drains in-flight work before calling
// disconnectPrisma() and exiting. A second, module-level handler here used to
// race that sequence: it awaited only disconnectPrisma() and called
// process.exit(0) as soon as that resolved, which is almost always faster
// than the real shutdown's drain step — so the process could exit mid-request
// or mid-job while the "real" handler was still cleaning up.

export { rateLimiter } from "../api/middleware/rateLimiter.js";
