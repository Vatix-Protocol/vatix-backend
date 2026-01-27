import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

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
    const isProduction = process.env.NODE_ENV === "production";
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      throw new Error("DATABASE_URL environment variable is not set");
    }

    // create postgres connection pool
    pgPool = new Pool({ connectionString: databaseUrl });
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

/**
 * set up graceful shutdown handlers
 */
function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Closing database connection...`);
    await disconnectPrisma();
    process.exit(0);
  };

  // handle different termination signals
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("beforeExit", async () => {
    await disconnectPrisma();
  });
}

setupGracefulShutdown();
