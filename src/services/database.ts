import { Prisma, PrismaClient } from '../generated/prisma/client';
import { getPrismaClient, getPool } from './prisma';

/**
 * Database metrics interface
 */
export interface DatabaseMetrics {
  totalConnections: number;
  idleConnections: number;
  waitingRequests: number;
}

/**
 * DatabaseService provides helper methods for common database operations
 * building on top of the Prisma Client
 */
class DatabaseService {
  /**
   * Get the Prisma client instance
   * Fetches dynamically to handle reconnection after disconnect
   */
  private get prisma(): PrismaClient {
    return getPrismaClient();
  }

  /**
   * Execute raw SQL queries
   * Use for complex queries that can't be expressed with Prisma Client
   *
   * @param query - SQL query string with $1, $2, etc. placeholders
   * @param params - Array of parameter values
   * @returns Query result
   */
  async executeRaw<T = unknown>(
    query: string,
    params: unknown[] = []
  ): Promise<T> {
    try {
      const result = await this.prisma.$queryRawUnsafe<T>(query, ...params);
      return result;
    } catch (error) {
      console.error('Raw query execution failed:', error);
      throw error;
    }
  }

  /**
   * Execute multiple operations in a transaction
   * All operations succeed or fail together - critical for CLOB operations
   *
   * @param operations - Function that receives prisma client and returns operations
   * @returns Result of the transaction
   */
  async transaction<T>(
    operations: (prisma: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        return await operations(tx);
      });
      return result;
    } catch (error) {
      console.error('Transaction failed, rolling back:', error);
      throw error;
    }
  }

  /**
   * Check database connectivity
   * Returns true if database is reachable, false otherwise
   *
   * @returns boolean indicating database health
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      console.error('Database health check failed:', error);
      return false;
    }
  }

  /**
   * Get database metrics (connection pool status)
   *
   * @returns DatabaseMetrics object with pool statistics
   */
  getMetrics(): DatabaseMetrics {
    const pool = getPool();

    if (!pool) {
      return {
        totalConnections: 0,
        idleConnections: 0,
        waitingRequests: 0,
      };
    }

    return {
      totalConnections: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingRequests: pool.waitingCount,
    };
  }

  /**
   * Get the underlying Prisma client
   * Use this for standard Prisma operations
   *
   * @returns PrismaClient instance
   */
  getClient(): PrismaClient {
    return this.prisma;
  }
}

/**
 * Singleton instance of DatabaseService
 */
export const db = new DatabaseService();

export { DatabaseService };
