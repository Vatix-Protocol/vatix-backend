import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { db, DatabaseService, DatabaseMetrics } from "./database";
import { disconnectPrisma, getPrismaClient } from "./prisma";

describe("DatabaseService", () => {
  afterEach(async () => {
    await disconnectPrisma();
    vi.restoreAllMocks();
  });

  describe("singleton instance", () => {
    it("should export a singleton db instance", () => {
      expect(db).toBeDefined();
      expect(db).toBeInstanceOf(DatabaseService);
    });

    it("should provide access to underlying Prisma client", () => {
      const client = db.getClient();
      expect(client).toBeDefined();
      expect(client).toBe(getPrismaClient());
    });
  });

  describe("healthCheck", () => {
    it("should return true for working database", async () => {
      const isHealthy = await db.healthCheck();
      expect(isHealthy).toBe(true);
    });

    it("should return false when database is unreachable", async () => {
      // mock getPrismaClient to return a client that fails
      const mockPrisma = {
        $queryRaw: vi.fn().mockRejectedValue(new Error("Connection refused")),
      };

      const prismaModule = await import("./prisma");
      vi.spyOn(prismaModule, "getPrismaClient").mockReturnValue(
        mockPrisma as unknown as ReturnType<typeof prismaModule.getPrismaClient>
      );

      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const service = new DatabaseService();
      const isHealthy = await service.healthCheck();

      expect(isHealthy).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Database health check failed:",
        expect.any(Error)
      );
    });
  });

  describe("executeRaw", () => {
    it("should execute raw SQL queries successfully", async () => {
      const result =
        await db.executeRaw<Array<{ result: number }>>("SELECT 1 as result");

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].result).toBe(1);
    });

    it("should execute raw SQL queries with parameters", async () => {
      const result = await db.executeRaw<Array<{ sum: number }>>(
        "SELECT $1::int + $2::int as sum",
        [5, 3]
      );

      expect(result).toBeDefined();
      expect(result[0].sum).toBe(8);
    });

    it("should throw error for invalid queries", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      await expect(
        db.executeRaw("SELECT * FROM non_existent_table_xyz")
      ).rejects.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Raw query execution failed:",
        expect.any(Error)
      );
    });
  });

  describe("transaction", () => {
    it("should execute operations in a transaction", async () => {
      const result = await db.transaction(async (tx) => {
        // execute a simple query inside transaction
        const queryResult = await tx.$queryRaw<Array<{ value: number }>>`
          SELECT 42 as value
        `;
        return queryResult[0].value;
      });

      expect(result).toBe(42);
    });

    it("should execute multiple operations atomically", async () => {
      const result = await db.transaction(async (tx) => {
        const first = await tx.$queryRaw<Array<{ a: number }>>`SELECT 1 as a`;
        const second = await tx.$queryRaw<Array<{ b: number }>>`SELECT 2 as b`;

        return {
          first: first[0].a,
          second: second[0].b,
        };
      });

      expect(result.first).toBe(1);
      expect(result.second).toBe(2);
    });

    it("should rollback on error", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      await expect(
        db.transaction(async (tx) => {
          // first operation succeeds
          await tx.$queryRaw`SELECT 1`;

          // second operation fails - throws error
          throw new Error("Intentional error for rollback test");
        })
      ).rejects.toThrow("Intentional error for rollback test");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Transaction failed, rolling back:",
        expect.any(Error)
      );
    });

    it("should rollback when database operation fails", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      await expect(
        db.transaction(async (tx) => {
          // this should fail - invalid table
          await tx.$queryRaw`SELECT * FROM definitely_not_a_real_table`;
        })
      ).rejects.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Transaction failed, rolling back:",
        expect.any(Error)
      );
    });
  });

  describe("getMetrics", () => {
    it("should return database metrics", () => {
      // ensure client is initialized
      getPrismaClient();

      const metrics: DatabaseMetrics = db.getMetrics();

      expect(metrics).toBeDefined();
      expect(typeof metrics.totalConnections).toBe("number");
      expect(typeof metrics.idleConnections).toBe("number");
      expect(typeof metrics.waitingRequests).toBe("number");
    });

    it("should return valid connection pool statistics", async () => {
      // make a query to ensure pool is active
      await db.healthCheck();

      const metrics = db.getMetrics();

      expect(metrics.totalConnections).toBeGreaterThanOrEqual(0);
      expect(metrics.idleConnections).toBeGreaterThanOrEqual(0);
      expect(metrics.waitingRequests).toBeGreaterThanOrEqual(0);
      // idle + active should not exceed total
      expect(metrics.idleConnections).toBeLessThanOrEqual(
        metrics.totalConnections
      );
    });

    it("should return zero metrics when pool is not initialized", async () => {
      // mock getPool to return null
      const prismaModule = await import("./prisma");
      vi.spyOn(prismaModule, "getPool").mockReturnValue(null);

      const service = new DatabaseService();
      const metrics = service.getMetrics();

      expect(metrics).toEqual({
        totalConnections: 0,
        idleConnections: 0,
        waitingRequests: 0,
      });
    });
  });

  describe("integration", () => {
    it("should work with actual database tables", async () => {
      const markets = await db.transaction(async (tx) => {
        return await tx.market.findMany({ take: 5 });
      });

      expect(Array.isArray(markets)).toBe(true);
    });

    it("should handle concurrent operations", async () => {
      const operations = [
        db.executeRaw<Array<{ n: number }>>("SELECT 1 as n"),
        db.executeRaw<Array<{ n: number }>>("SELECT 2 as n"),
        db.executeRaw<Array<{ n: number }>>("SELECT 3 as n"),
      ];

      const results = await Promise.all(operations);

      expect(results[0][0].n).toBe(1);
      expect(results[1][0].n).toBe(2);
      expect(results[2][0].n).toBe(3);
    });
  });
});
