import { Prisma, PrismaClient } from "../generated/prisma/client";
import { getPrismaClient, getPool } from "./prisma";
import { config } from "../config";

/**
 * Database metrics interface
 */
export interface DatabaseMetrics {
  totalConnections: number;
  idleConnections: number;
  waitingRequests: number;
}

/**
 * Thrown by {@link DatabaseService.withStatementTimeout} when Postgres aborts a
 * query for exceeding the configured `statement_timeout`. Callers translate
 * this into a 503 rather than a generic 500 — the request was shed on purpose.
 */
export class StatementTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: { cause?: unknown }) {
    super(
      `Database query exceeded the ${timeoutMs}ms statement timeout and was aborted`,
      options
    );
    this.name = "StatementTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Postgres SQLSTATE for "canceling statement due to statement timeout". */
const PG_STATEMENT_TIMEOUT_SQLSTATE = "57014";

/**
 * True when `error` is (or wraps) a Postgres statement-timeout cancellation.
 * The driver adapter surfaces the SQLSTATE on `.code`, but Prisma may re-wrap
 * it, so we also check the nested `cause` and fall back to the message text.
 */
function isStatementTimeoutError(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (code === PG_STATEMENT_TIMEOUT_SQLSTATE) {
        return true;
      }
      const message = (current as { message?: unknown }).message;
      if (
        typeof message === "string" &&
        /canceling statement due to statement timeout|statement timeout/i.test(
          message
        )
      ) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
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
      console.error("Raw query execution failed:", error);
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
      console.error("Transaction failed, rolling back:", error);
      throw error;
    }
  }

  /**
   * Run `operations` inside a transaction whose per-statement execution time is
   * capped at `timeoutMs` via Postgres `SET LOCAL statement_timeout` (#983).
   *
   * Unbounded read paths (e.g. `GET /v1/markets` with no upper limit on the
   * scanned set) can otherwise run for seconds against a pathological or
   * unindexed filter, holding a pool connection and stalling every request
   * queued behind it. With the cap, Postgres aborts the offending query with
   * SQLSTATE 57014, which this method rethrows as {@link StatementTimeoutError}.
   *
   * @param operations - receives a transaction client; every query it issues
   *   shares the timeout
   * @param timeoutMs - positive integer milliseconds; defaults to
   *   `config.databaseStatementTimeoutMs`
   * @returns the value returned by `operations`
   * @throws {StatementTimeoutError} when the timeout fires
   * @throws the original error for any other failure (transaction rolls back)
   */
  async withStatementTimeout<T>(
    operations: (tx: Prisma.TransactionClient) => Promise<T>,
    timeoutMs: number = config.databaseStatementTimeoutMs
  ): Promise<T> {
    const ms = Math.floor(timeoutMs);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new TypeError(
        `withStatementTimeout: timeoutMs must be a positive integer, got ${timeoutMs}`
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // `SET LOCAL` does not accept bind parameters; `ms` is a validated
        // integer above, so string interpolation here is injection-safe.
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${ms}`);
        return await operations(tx);
      });
    } catch (error) {
      if (isStatementTimeoutError(error)) {
        console.error(
          `Query aborted by ${ms}ms statement timeout (#983):`,
          error
        );
        throw new StatementTimeoutError(ms, { cause: error });
      }
      console.error(
        "Statement-timeout transaction failed, rolling back:",
        error
      );
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
      console.error("Database health check failed:", error);
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
