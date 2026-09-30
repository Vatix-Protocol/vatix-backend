/**
 * Submission Queue Types
 *
 * Typed representation of items held in the oracle submission queue
 * before they are dispatched on-chain.
 *
 * @module apps/oracle/submission-queue
 */

import { randomUUID } from "crypto";
import type { ProviderResult, ResolutionRequest } from "./provider-adapter.js";
import type { ILogger } from "../../packages/shared/src/logger.js";
import { redis } from "../../src/services/redis.js";

/** Possible states of a queued submission. */
export type SubmissionStatus = "pending" | "submitted" | "failed";

/** A single item waiting to be submitted to the chain. */
export interface SubmissionQueueItem {
  /** Unique identifier for this queue entry. */
  id: string;
  /** The original resolution request that triggered this submission. */
  request: ResolutionRequest;
  /** The resolved result from the provider. */
  result: ProviderResult;
  /** Current processing status. */
  status: SubmissionStatus;
  /** ISO timestamp when the item was enqueued. */
  enqueuedAt: string;
  /** Number of submission attempts made so far. */
  attempts: number;
  /** ISO timestamp of the last attempt, if any. */
  lastAttemptAt?: string;
  /** Error message from the last failed attempt, if any. */
  lastError?: string;
}

export interface SubmissionQueueLogMeta {
  id: string;
  marketId: string;
  oracleAddress: string;
  status: SubmissionStatus;
  enqueuedAt: string;
  attempts?: number;
  lastAttemptAt?: string;
  lastError?: string;
}

/** Snapshot of the submission queue at a point in time. */
export interface SubmissionQueueSnapshot {
  pending: number;
  submitted: number;
  failed: number;
  items: SubmissionQueueItem[];
}

const VALID_STATUSES: SubmissionStatus[] = ["pending", "submitted", "failed"];

export class SubmissionQueueValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "SubmissionQueueValidationError";
  }
}

/**
 * Validates a SubmissionQueueItem, throwing a 400-status error on invalid input.
 *
 * @throws {SubmissionQueueValidationError} When the item is invalid.
 */
export function validateSubmissionQueueItem(
  item: unknown
): SubmissionQueueItem {
  if (!item || typeof item !== "object") {
    throw new SubmissionQueueValidationError("item must be an object");
  }
  const i = item as Record<string, unknown>;

  if (!i.id || typeof i.id !== "string") {
    throw new SubmissionQueueValidationError("id must be a non-empty string");
  }
  if (!i.request || typeof i.request !== "object") {
    throw new SubmissionQueueValidationError("request must be an object");
  }
  const req = i.request as Record<string, unknown>;
  if (!req.marketId || typeof req.marketId !== "string") {
    throw new SubmissionQueueValidationError(
      "request.marketId must be a non-empty string"
    );
  }
  if (!req.oracleAddress || typeof req.oracleAddress !== "string") {
    throw new SubmissionQueueValidationError(
      "request.oracleAddress must be a non-empty string"
    );
  }
  if (!i.result || typeof i.result !== "object") {
    throw new SubmissionQueueValidationError("result must be an object");
  }
  if (!VALID_STATUSES.includes(i.status as SubmissionStatus)) {
    throw new SubmissionQueueValidationError(
      `status must be one of: ${VALID_STATUSES.join(", ")}`
    );
  }
  if (!i.enqueuedAt || typeof i.enqueuedAt !== "string") {
    throw new SubmissionQueueValidationError(
      "enqueuedAt must be a non-empty string"
    );
  }
  if (!Number.isInteger(i.attempts) || (i.attempts as number) < 0) {
    throw new SubmissionQueueValidationError(
      "attempts must be a non-negative integer"
    );
  }

  return item as SubmissionQueueItem;
}

/**
 * In-memory submission queue (deprecated — use Redis via apps/workers/src/oracle/redis-submission-queue.ts).
 * Provided for backwards compatibility during migration.
 */
export class SubmissionQueue {
  private items: SubmissionQueueItem[] = [];

  constructor(private readonly logger: ILogger) {}

  enqueue(item: SubmissionQueueItem): void {
    validateSubmissionQueueItem(item);
    this.items.push(item);
    this.logger.info("Oracle submission queued", {
      id: item.id,
      marketId: item.request.marketId,
      oracleAddress: item.request.oracleAddress,
      status: item.status,
      enqueuedAt: item.enqueuedAt,
      attempts: item.attempts,
      lastAttemptAt: item.lastAttemptAt,
      lastError: item.lastError,
    } satisfies SubmissionQueueLogMeta);
  }
}

/** Redis client interface for Oracle HA submission locks. */
export interface OracleLockRedisClient {
  set(
    key: string,
    value: string,
    mode: "PX",
    duration: number,
    flag: "NX"
  ): Promise<string | null>;
  eval(
    script: string,
    numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

export interface OracleSubmissionLockConfig {
  redisClient?: OracleLockRedisClient;
  /** Lock TTL in milliseconds. Default: 60,000 ms. */
  ttlMs?: number;
  /** Key prefix override. Falls back to REDIS_KEY_PREFIX (default: "vatix:"). */
  keyPrefix?: string;
  logger?: ILogger;
}

/**
 * Distributed submission lock manager for Oracle High Availability (HA) (#1168).
 *
 * Guarantees that only one oracle replica resolves and enqueues on-chain
 * submissions for a given market at any time, preventing duplicate gas spend,
 * concurrent signing, and database race conditions.
 */
export class OracleSubmissionLock {
  private readonly redisClient: OracleLockRedisClient;
  private readonly ttlMs: number;
  private readonly keyPrefix: string;
  private readonly logger?: ILogger;

  constructor(config: OracleSubmissionLockConfig = {}) {
    this.redisClient =
      config.redisClient ?? (redis as unknown as OracleLockRedisClient);
    this.ttlMs = config.ttlMs ?? 60_000;
    const envPrefix = process.env.REDIS_KEY_PREFIX;
    this.keyPrefix =
      config.keyPrefix !== undefined && config.keyPrefix !== ""
        ? config.keyPrefix
        : envPrefix !== undefined && envPrefix !== ""
        ? envPrefix
        : "vatix:";
    this.logger = config.logger;
  }

  getLockKey(marketId: string): string {
    return `${this.keyPrefix}oracle:submission-lock:${marketId}`;
  }

  /**
   * Attempts to atomically acquire a submission lock for the given market via SET NX PX.
   *
   * @param marketId Market identifier
   * @param lockId   Unique token for this holder (defaults to a random UUID)
   * @param ttlMs    Optional TTL override in ms
   * @returns The lock holder token on success, or null if already held / unavailable.
   */
  async acquireLock(
    marketId: string,
    lockId: string = randomUUID(),
    ttlMs: number = this.ttlMs
  ): Promise<string | null> {
    const lockKey = this.getLockKey(marketId);
    try {
      const res = await this.redisClient.set(lockKey, lockId, "PX", ttlMs, "NX");
      if (res === "OK") {
        this.logger?.debug("Acquired oracle submission lock", {
          marketId,
          lockId,
          lockKey,
        });
        return lockId;
      }
      this.logger?.info(
        "Oracle submission lock already held by another instance",
        { marketId, lockKey }
      );
      return null;
    } catch (err) {
      this.logger?.error(
        "Failed to acquire oracle submission lock (failing closed)",
        {
          marketId,
          lockKey,
          error: err instanceof Error ? err.message : String(err),
        }
      );
      // Fail closed: if Redis is unreachable or errored, do not risk duplicate submission
      return null;
    }
  }

  /**
   * Safely releases the submission lock for the given market using CAS (compare-and-delete).
   *
   * Only deletes the lock if the value currently stored in Redis matches `lockId`.
   * This prevents an instance from accidentally deleting a lock that expired
   * and was acquired by another instance.
   *
   * @returns true if the lock was successfully released, false otherwise.
   */
  async releaseLock(marketId: string, lockId: string): Promise<boolean> {
    const lockKey = this.getLockKey(marketId);
    const luaScript = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;
    try {
      const res = await this.redisClient.eval(luaScript, 1, lockKey, lockId);
      const released = Number(res) === 1;
      if (released) {
        this.logger?.debug("Released oracle submission lock", {
          marketId,
          lockId,
        });
      }
      return released;
    } catch (err) {
      this.logger?.warn("Failed to release oracle submission lock", {
        marketId,
        lockId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Extends the TTL of a currently held lock (heartbeat/extension).
   * Only extends if `lockId` matches current holder.
   */
  async extendLock(
    marketId: string,
    lockId: string,
    ttlMs: number = this.ttlMs
  ): Promise<boolean> {
    const lockKey = this.getLockKey(marketId);
    const luaScript = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end
`;
    try {
      const res = await this.redisClient.eval(
        luaScript,
        1,
        lockKey,
        lockId,
        String(ttlMs)
      );
      return Number(res) === 1;
    } catch (err) {
      this.logger?.warn("Failed to extend oracle submission lock", {
        marketId,
        lockId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

