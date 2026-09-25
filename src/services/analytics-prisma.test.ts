import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getAnalyticsPrismaClient,
  disconnectAnalyticsPrisma,
  isAnalyticsDatabaseConfigured,
  getAnalyticsPool,
  assertAnalyticsDatabaseConfig,
  AnalyticsDatabaseConfigError,
} from "./analytics-prisma.js";
import { config } from "../config.js";

describe("Analytics Prisma Client Service (#743)", () => {
  afterEach(async () => {
    await disconnectAnalyticsPrisma();
    delete process.env.ANALYTICS_DATABASE_URL;
    vi.restoreAllMocks();
  });

  it("returns a defined client instance", () => {
    const client = getAnalyticsPrismaClient();
    expect(client).toBeDefined();
  });

  it("returns the same instance (singleton behavior)", () => {
    const client1 = getAnalyticsPrismaClient();
    const client2 = getAnalyticsPrismaClient();
    expect(client1).toBe(client2);
  });

  it("falls back to the primary database when ANALYTICS_DATABASE_URL is unset", () => {
    expect(process.env.ANALYTICS_DATABASE_URL).toBeUndefined();
    expect(isAnalyticsDatabaseConfigured()).toBe(false);

    const client = getAnalyticsPrismaClient();
    expect(client).toBeDefined();
  });

  it("executes a simple query successfully against the resolved connection", async () => {
    const client = getAnalyticsPrismaClient();
    const result = await client.$queryRaw<
      Array<{ result: number }>
    >`SELECT 1 as result`;
    expect(result[0].result).toBe(1);
  });

  it("creates a new instance after disconnect", async () => {
    const client1 = getAnalyticsPrismaClient();
    await disconnectAnalyticsPrisma();
    const client2 = getAnalyticsPrismaClient();
    expect(client2).toBeDefined();
    expect(client2).not.toBe(client1);
  });

  it("handles multiple disconnect calls gracefully", async () => {
    getAnalyticsPrismaClient();
    await disconnectAnalyticsPrisma();
    await expect(disconnectAnalyticsPrisma()).resolves.toBeUndefined();
  });

  describe("connection-pool isolation (#979)", () => {
    it("bounds the analytics pool by ANALYTICS_DATABASE_POOL_SIZE", () => {
      getAnalyticsPrismaClient();
      const pool = getAnalyticsPool();
      expect(pool).not.toBeNull();
      // pg exposes the resolved options on the pool instance.
      expect(
        (pool as unknown as { options: { max: number } }).options.max
      ).toBe(config.analyticsDatabasePoolSize);
    });

    it("uses a small default pool cap independent of the primary pool", () => {
      // Default is 5 and must not simply inherit DATABASE_POOL_SIZE (10).
      expect(config.analyticsDatabasePoolSize).toBe(5);
      expect(config.analyticsDatabasePoolSize).toBeLessThan(
        config.databasePoolSize
      );
    });
  });

  describe("production/dev split (#979)", () => {
    it("throws in production when no dedicated ANALYTICS_DATABASE_URL is set", () => {
      expect(() =>
        assertAnalyticsDatabaseConfig({
          nodeEnv: "production",
          databaseUrl: "postgresql://primary/db",
        })
      ).toThrow(AnalyticsDatabaseConfigError);
    });

    it("throws in production when ANALYTICS_DATABASE_URL equals DATABASE_URL", () => {
      expect(() =>
        assertAnalyticsDatabaseConfig({
          nodeEnv: "production",
          databaseUrl: "postgresql://primary/db",
          analyticsDatabaseUrl: "postgresql://primary/db",
        })
      ).toThrow(/dedicated read replica/);
    });

    it("allows a distinct replica URL in production", () => {
      const resolved = assertAnalyticsDatabaseConfig({
        nodeEnv: "production",
        databaseUrl: "postgresql://primary/db",
        analyticsDatabaseUrl: "postgresql://replica/db",
      });
      expect(resolved).toEqual({
        connectionString: "postgresql://replica/db",
        usingReplica: true,
      });
    });

    it("falls back to the primary connection outside production (local stub)", () => {
      const resolved = assertAnalyticsDatabaseConfig({
        nodeEnv: "development",
        databaseUrl: "postgresql://primary/db",
      });
      expect(resolved).toEqual({
        connectionString: "postgresql://primary/db",
        usingReplica: false,
      });
    });
  });
});
