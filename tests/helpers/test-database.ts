import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, Client } from "pg";
import "dotenv/config";

/**
 * Shared test database client for parallel test execution.
 *
 * This module provides a singleton Prisma client and connection pool
 * that can be shared across all test files, preventing connection pool
 * exhaustion and enabling safe parallel test execution.
 *
 * For database tests that modify data, use the advisory lock pattern:
 *
 *   import {
 *     getTestPrismaClient,
 *     cleanDatabase,
 *     disconnectTestPrisma,
 *     acquireDatabaseLock,
 *     releaseDatabaseLock
 *   } from '../tests/helpers/test-database';
 *
 *   beforeAll(async () => {
 *     await acquireDatabaseLock();  // Serializes database tests
 *     prisma = getTestPrismaClient();
 *   });
 *
 *   afterAll(async () => {
 *     try {
 *       await releaseDatabaseLock();
 *     } finally {
 *       await disconnectTestPrisma();
 *     }
 *   });
 *
 *   beforeEach(async () => {
 *     await cleanDatabase();
 *   });
 */

let prismaInstance: PrismaClient | null = null;
let poolInstance: Pool | null = null;
let lockClient: Client | null = null;

// Advisory lock key for serializing database tests
const DATABASE_TEST_LOCK_KEY = 1234567890;
const DATABASE_TEST_LOCK_TIMEOUT_MS = 30_000;
const DATABASE_TEST_LOCK_RETRY_MS = 100;

/**
 * Validates a database URL format.
 * Returns true if valid, false otherwise.
 * Valid URLs must:
 * - Be a non-empty string
 * - Use postgresql:// or postgres:// scheme
 * - Include a hostname
 * @param url - The URL string to validate
 * @returns true if valid, false if invalid
 */
export function validateDatabaseUrl(url: unknown): boolean {
  // Type check: must be a string
  if (typeof url !== "string") {
    return false;
  }

  // Must not be empty or whitespace-only
  if (!url || url.trim() === "") {
    return false;
  }

  // Must be a valid URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Must use postgresql:// or postgres:// scheme
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    return false;
  }

  // Must include a hostname
  if (!parsed.hostname) {
    return false;
  }

  return true;
}

function getDatabaseUrl(): string {
  const url =
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5433/vatix";

  if (!validateDatabaseUrl(url)) {
    throw new Error(
      `Invalid DATABASE_URL: must be a valid postgresql:// or postgres:// URL with hostname`
    );
  }

  return url;
}

/**
 * Returns the singleton Prisma client for tests.
 * Creates the client on first call, reuses it on subsequent calls.
 */
export function getTestPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    poolInstance = new Pool({ connectionString: getDatabaseUrl() });
    const adapter = new PrismaPg(poolInstance);
    prismaInstance = new PrismaClient({ adapter });
  }

  return prismaInstance;
}

/**
 * Returns the singleton connection pool for tests.
 * Useful for tests that need to execute raw SQL queries.
 * Creates the pool on first call if not already created.
 */
export function getTestPool(): Pool {
  if (!poolInstance) {
    // This will create both pool and prisma client
    getTestPrismaClient();
  }

  return poolInstance!;
}

/**
 * Cleans all data from the database in the correct order
 * to respect foreign key constraints.
 *
 * Delete order: orders → positions → markets
 *
 * @param client - Optional Prisma client to use. If not provided, uses the singleton.
 * @throws Error if client is provided but is not a valid PrismaClient instance
 */
export async function cleanDatabase(client?: PrismaClient): Promise<void> {
  // Validate the optional client parameter
  if (client !== undefined && typeof client !== "object") {
    throw new Error(
      "Invalid cleanDatabase parameter: client must be a PrismaClient instance or undefined"
    );
  }

  const prisma = client ?? getTestPrismaClient();

  // Delete in order respecting foreign key constraints
  await prisma.trade.deleteMany();
  await prisma.order.deleteMany();
  await prisma.userPosition.deleteMany();
  await prisma.market.deleteMany();
}

/**
 * Acquires a PostgreSQL advisory lock to serialize database tests.
 * This prevents race conditions when multiple test files run in parallel.
 * Call this in beforeAll() for tests that modify database state.
 *
 * Uses a dedicated connection (not from the pool) to hold the lock,
 * ensuring the lock persists for the entire test suite duration.
 */
export async function acquireDatabaseLock(): Promise<void> {
  if (lockClient) {
    throw new Error("Database advisory lock is already held");
  }

  // Create a dedicated connection for holding the lock
  const client = new Client({ connectionString: getDatabaseUrl() });

  try {
    await client.connect();

    const deadline = Date.now() + DATABASE_TEST_LOCK_TIMEOUT_MS;
    while (true) {
      const result = await client.query(
        `SELECT pg_try_advisory_lock(${DATABASE_TEST_LOCK_KEY}) AS acquired`
      );
      if (result.rows[0]?.acquired === true) {
        lockClient = client;
        return;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out after ${DATABASE_TEST_LOCK_TIMEOUT_MS}ms waiting for the database advisory lock`
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(DATABASE_TEST_LOCK_RETRY_MS, remaining))
      );
    }
  } catch (error) {
    try {
      await client.end();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Failed to acquire the database advisory lock and close its connection"
      );
    }
    throw error;
  }
}

/**
 * Releases the PostgreSQL advisory lock.
 * Call this in afterAll() after all database tests complete.
 */
export async function releaseDatabaseLock(): Promise<void> {
  if (!lockClient) return;

  const client = lockClient;
  let unlockError: unknown;
  try {
    const result = await client.query(
      `SELECT pg_advisory_unlock(${DATABASE_TEST_LOCK_KEY}) AS unlocked`
    );
    if (result.rows[0]?.unlocked !== true) {
      throw new Error("Database advisory lock was not held by its connection");
    }
  } catch (error) {
    unlockError = error;
  }

  try {
    await client.end();
  } catch (endError) {
    if (unlockError) {
      throw new AggregateError(
        [unlockError, endError],
        "Failed to release the database advisory lock and close its connection"
      );
    }
    throw endError;
  } finally {
    lockClient = null;
  }

  if (unlockError) {
    throw unlockError;
  }
}

/**
 * Disconnects the shared Prisma client and closes the connection pool.
 * Should be called in afterAll hooks to clean up resources.
 * Automatically releases any held database lock.
 */
export async function disconnectTestPrisma(): Promise<void> {
  const cleanupErrors: unknown[] = [];

  try {
    await releaseDatabaseLock();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (prismaInstance) {
    try {
      await prismaInstance.$disconnect();
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      prismaInstance = null;
    }
  }

  if (poolInstance) {
    try {
      await poolInstance.end();
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      poolInstance = null;
    }
  }

  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Failed to disconnect test database");
  }
}
