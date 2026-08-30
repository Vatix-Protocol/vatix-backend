/**
 * Read-only Prisma Client for analytics/reporting queries (#743, #979).
 *
 * Points at ANALYTICS_DATABASE_URL when configured — intended to be a read
 * replica — so heavy analytical queries don't compete with the primary's
 * OLTP write/read workload.
 *
 * Connection-pool isolation (#979): the pool backing this client is bounded
 * by ANALYTICS_DATABASE_POOL_SIZE (default 5), separate from the primary's
 * DATABASE_POOL_SIZE. Without a cap, a burst of expensive admin analytics
 * queries could open enough connections to exhaust Postgres `max_connections`
 * and starve the matching/OLTP path.
 *
 * Production/dev split (#979):
 *   - NODE_ENV=production : a dedicated ANALYTICS_DATABASE_URL, distinct from
 *     DATABASE_URL, is REQUIRED. `getAnalyticsPrismaClient()` throws rather
 *     than silently run analytics against the primary connection.
 *   - otherwise           : falls back to the primary DATABASE_URL (still
 *     with the small analytics pool cap) so local dev and tests work without
 *     provisioning a replica.
 *
 * This client is for reads only — no write path in this codebase should
 * import it. It shares the same schema/generated client as the primary
 * connection since a read replica is schema-identical to the primary.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "../config.js";

let analyticsPrismaInstance: PrismaClient | null = null;
let analyticsPgPool: Pool | null = null;

/** Thrown when the analytics database is misconfigured for the environment. */
export class AnalyticsDatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsDatabaseConfigError";
  }
}

/** True when ANALYTICS_DATABASE_URL is configured (vs. falling back to the primary). */
export function isAnalyticsDatabaseConfigured(): boolean {
  return Boolean(config.analyticsDatabaseUrl);
}

export interface AnalyticsDbConfigInput {
  nodeEnv: string;
  databaseUrl: string;
  analyticsDatabaseUrl?: string;
}

/**
 * Enforce the production/dev split (#979) and report which connection the
 * analytics client will use.
 *
 * In production a dedicated `analyticsDatabaseUrl`, distinct from
 * `databaseUrl`, is mandatory — otherwise this throws rather than let heavy
 * analytics queries share (and potentially starve) the primary pool.
 *
 * @throws {AnalyticsDatabaseConfigError}
 */
export function assertAnalyticsDatabaseConfig(input: AnalyticsDbConfigInput): {
  connectionString: string;
  usingReplica: boolean;
} {
  const { nodeEnv, databaseUrl, analyticsDatabaseUrl } = input;
  const isDedicated =
    Boolean(analyticsDatabaseUrl) && analyticsDatabaseUrl !== databaseUrl;

  if (nodeEnv === "production" && !isDedicated) {
    throw new AnalyticsDatabaseConfigError(
      "ANALYTICS_DATABASE_URL must be set to a dedicated read replica " +
        "(distinct from DATABASE_URL) in production. Refusing to run analytics " +
        "queries against the primary connection pool, which would risk " +
        "starving the matching/OLTP path."
    );
  }

  return {
    connectionString: analyticsDatabaseUrl ?? databaseUrl,
    usingReplica: isDedicated,
  };
}

function resolveAnalyticsConnectionString(): {
  connectionString: string;
  usingReplica: boolean;
} {
  return assertAnalyticsDatabaseConfig({
    nodeEnv: config.nodeEnv,
    databaseUrl: config.databaseUrl,
    analyticsDatabaseUrl: config.analyticsDatabaseUrl,
  });
}

/** The pg Pool backing the analytics client, for metrics/tests. */
export function getAnalyticsPool(): Pool | null {
  return analyticsPgPool;
}

/**
 * Get the singleton analytics Prisma Client instance, creating it on first
 * use. Pool size is bounded by ANALYTICS_DATABASE_POOL_SIZE.
 *
 * @throws {AnalyticsDatabaseConfigError} in production when no dedicated
 *   ANALYTICS_DATABASE_URL is configured.
 */
export function getAnalyticsPrismaClient(): PrismaClient {
  if (!analyticsPrismaInstance) {
    const isProduction = config.nodeEnv === "production";
    const { connectionString, usingReplica } =
      resolveAnalyticsConnectionString();
    const maxConnections = config.analyticsDatabasePoolSize;

    analyticsPgPool = new Pool({ connectionString, max: maxConnections });
    const adapter = new PrismaPg(analyticsPgPool);

    analyticsPrismaInstance = new PrismaClient({
      adapter,
      log: isProduction ? ["error"] : ["error", "warn"],
    });

    // Structured init log — never logs the connection string / credentials.
    const line = {
      ts: new Date().toISOString(),
      level: usingReplica ? "info" : "warn",
      message: usingReplica
        ? "Analytics Prisma client initialized against dedicated replica"
        : "Analytics Prisma client falling back to primary database (non-production only)",
      component: "analytics-prisma",
      correlationId: randomUUID(),
      usingReplica,
      poolMaxConnections: maxConnections,
      nodeEnv: config.nodeEnv,
    };
    if (usingReplica) {
      console.log(JSON.stringify(line));
    } else {
      console.warn(JSON.stringify(line));
    }
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
