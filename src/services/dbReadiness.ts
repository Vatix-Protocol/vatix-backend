import { getPrismaClient } from "../lib/prisma";
import type { PrismaClient } from "@prisma/client";

export type DbReadinessErrorCode = "DEPENDENCY_TIMEOUT" | "DEPENDENCY_UNAVAILABLE";

export interface DbReadinessError extends Error {
  code: DbReadinessErrorCode;
  cause?: unknown;
}

export interface DbReadinessOptions {
  client?: Pick<PrismaClient, "$queryRaw">;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

function makeError(code: DbReadinessErrorCode, cause?: unknown): DbReadinessError {
  const error = new Error(`db: ${code}`) as DbReadinessError;
  error.code = code;
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

/**
 * Readiness probe for the database dependency.
 *
 * Runs `SELECT 1` against the shared Prisma client and resolves within a
 * bounded deadline. Rejects with a typed error carrying a stable code:
 * `DEPENDENCY_TIMEOUT` when the deadline is exceeded, `DEPENDENCY_UNAVAILABLE`
 * when the query fails for any other reason. The message contains only the
 * dependency name and code — never connection strings, hosts, or driver detail.
 *
 * The Prisma client is resolved lazily so callers and tests can inject a fake
 * via `options.client` without touching the Prisma singleton.
 */
export async function checkDbReadiness(options?: DbReadinessOptions): Promise<void> {
  const prisma = options?.client ?? getPrismaClient();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(makeError("DEPENDENCY_TIMEOUT"));
    }, timeoutMs);
  });

  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
  } catch (error) {
    if (error instanceof Error && (error as DbReadinessError).code === "DEPENDENCY_TIMEOUT") {
      throw error;
    }
    throw makeError("DEPENDENCY_UNAVAILABLE", error);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
