/**
 * Read-only Prisma Client for analytics/reporting queries (#743).
 *
 * Points at ANALYTICS_DATABASE_URL when configured — intended to be a read
 * replica — so heavy analytical queries don't compete with the primary's
 * OLTP write/read workload. Falls back to the primary DATABASE_URL when
 * ANALYTICS_DATABASE_URL is unset, so analytics call sites work unmodified
 * in environments (e.g. local dev, tests) that don't provision a replica.
 *
 * This client is for reads only — no write path in this codebase should
 * import it. It shares the same schema/generated client as the primary
 * connection since a read replica is schema-identical to the primary.
 */
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "../config.js";

let analyticsPrismaInstance: PrismaClient | null = null;
let analyticsPgPool: Pool | null = null;

/** True when ANALYTICS_DATABASE_URL is configured (vs. falling back to the primary). */
export function isAnalyticsDatabaseConfigured(): boolean {
  return Boolean(config.analyticsDatabaseUrl);
}

/**
 * Get the singleton analytics Prisma Client instance, creating it on first
 * use. Uses ANALYTICS_DATABASE_URL when set, otherwise falls back to the
 * primary config.databaseUrl (both are validated at boot — see src/env.ts).
 */
export function getAnalyticsPrismaClient(): PrismaClient {
  if (!analyticsPrismaInstance) {
    const connectionString = config.analyticsDatabaseUrl ?? config.databaseUrl;
    const isProduction = config.nodeEnv === "production";

    analyticsPgPool = new Pool({ connectionString });
    const adapter = new PrismaPg(analyticsPgPool);

    analyticsPrismaInstance = new PrismaClient({
      adapter,
      log: isProduction ? ["error"] : ["error", "warn"],
    });
  }

  return analyticsPrismaInstance;
}

/**
 * Disconnect the analytics Prisma Client and its connection pool.
 * Used for graceful shutdown and testing cleanup.
 */
export async function disconnectAnalyticsPrisma(): Promise<void> {
  if (analyticsPrismaInstance) {
    await analyticsPrismaInstance.$disconnect();
    analyticsPrismaInstance = null;
  }

  if (analyticsPgPool) {
    await analyticsPgPool.end();
    analyticsPgPool = null;
  }
}
