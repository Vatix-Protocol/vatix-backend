import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getPrismaClient, disconnectPrisma } from "./prisma";

describe("Prisma Client Service", () => {
  afterEach(async () => {
    await disconnectPrisma();
    vi.restoreAllMocks();
  });

  it("should return a defined Prisma Client instance", () => {
    const client = getPrismaClient();
    expect(client).toBeDefined();
    expect(client).toBeTruthy();
  });

  it("should return the same instance (singleton behavior)", () => {
    const client1 = getPrismaClient();
    const client2 = getPrismaClient();

    expect(client1).toBe(client2);
    expect(client1).toStrictEqual(client2);
  });

  it("should provide consistent access through getPrismaClient()", () => {
    const client = getPrismaClient();
    expect(client).toBeDefined();
    expect(getPrismaClient()).toBe(client);
  });

  it("should successfully connect to the database", async () => {
    const client = getPrismaClient();

    await expect(client.$queryRaw`SELECT 1 as result`).resolves.toBeDefined();
  });

  it("should execute a simple query successfully", async () => {
    const client = getPrismaClient();

    const result = await client.$queryRaw<
      Array<{ result: number }>
    >`SELECT 1 as result`;

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].result).toBe(1);
  });

  it("should disconnect without errors", async () => {
    const client = getPrismaClient();

    await client.$queryRaw`SELECT 1 as result`;

    await expect(disconnectPrisma()).resolves.toBeUndefined();
  });

  it("should handle multiple disconnect calls gracefully", async () => {
    const client = getPrismaClient();

    await client.$queryRaw`SELECT 1 as result`;

    await disconnectPrisma();

    await expect(disconnectPrisma()).resolves.toBeUndefined();
  });

  it("should create a new instance after disconnect", async () => {
    const client1 = getPrismaClient();
    await disconnectPrisma();

    const client2 = getPrismaClient();

    expect(client2).toBeDefined();

    await expect(client2.$queryRaw`SELECT 1 as result`).resolves.toBeDefined();
  });

  it("should be able to query the markets table", async () => {
    const client = getPrismaClient();

    // query the markets table (should return empty array if no data)
    const markets = await client.market.findMany({
      take: 1,
    });

    expect(Array.isArray(markets)).toBe(true);
  });

  describe("Graceful Shutdown", () => {
    // Regression guard (closes #747-#750): this module must NOT register its
    // own SIGINT/SIGTERM/beforeExit handlers. Every entrypoint that imports
    // it (API server, indexer, oracle, workers) owns a single shutdown
    // sequence that drains in-flight work before calling disconnectPrisma().
    // A second, faster module-level handler here previously raced that
    // sequence and could call process.exit(0) before the real shutdown
    // finished draining.
    it("should not register its own SIGINT/SIGTERM/beforeExit listeners", () => {
      const sigintCountBefore = process.listenerCount("SIGINT");
      const sigtermCountBefore = process.listenerCount("SIGTERM");
      const beforeExitCountBefore = process.listenerCount("beforeExit");

      getPrismaClient();

      expect(process.listenerCount("SIGINT")).toBe(sigintCountBefore);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermCountBefore);
      expect(process.listenerCount("beforeExit")).toBe(beforeExitCountBefore);
    });

    it("should log environment configuration in development", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      await disconnectPrisma();

      const client = getPrismaClient();
      expect(client).toBeDefined();

      process.env.NODE_ENV = originalEnv;
    });

    it("should log environment configuration in production", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      // disconnect to reset singleton
      await disconnectPrisma();

      const client = getPrismaClient();
      expect(client).toBeDefined();

      // restore original environment
      process.env.NODE_ENV = originalEnv;
    });
  });
});
