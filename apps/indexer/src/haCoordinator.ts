/**
 * Indexer High-Availability (HA) Coordinator & Shard Plan
 *
 * Implements leader election and horizontal shard coordination for indexer replicas.
 * Guarantees single-writer semantics per shard via Redis-backed CAS leader leases
 * and fencing tokens, preventing duplicate ingestion loops and DB cursor contention (#1167).
 *
 * @module apps/indexer/src/haCoordinator
 */

import { randomUUID } from "crypto";
import {
  indexerLeaderGauge,
  indexerLeaseRenewFailuresTotal,
} from "./metrics.js";
import { redis } from "../../../src/services/redis.js";

/** Redis client interface needed for HA leader lease. */
export interface IndexerRedisClient {
  acquireOrRenewLease(
    lockKey: string,
    fencingKey: string,
    holderId: string,
    ttlMs: number,
    knownToken: number
  ): Promise<number>;
  releaseLeaseIfHeld(
    lockKey: string,
    holderId: string,
    token: number
  ): Promise<boolean>;
}

export interface ShardPlan {
  /** Numerical ID of this shard (0-indexed). */
  shardId: number;
  /** Total number of horizontal shards across the cluster. */
  totalShards: number;
  /** Cursor checkpoint key used for storage. */
  cursorKey: string;
}

export interface IndexerHaConfig {
  /** Whether HA leader election is active. */
  enabled: boolean;
  /** Lease TTL in Redis in milliseconds. */
  ttlMs: number;
  /** Heartbeat renewal interval in milliseconds. */
  renewIntervalMs: number;
  /** Environment key prefix for Redis keys. */
  keyPrefix: string;
  /** Horizontal shard allocation plan. */
  shardPlan: ShardPlan;
}

export interface LeaderLeaseCallbacks {
  /** Fired when this replica is elected or promoted to leader. */
  onAcquired?: (token: number) => void | Promise<void>;
  /** Fired when this replica loses the lease or fails renewal. */
  onLost?: (reason: string) => void | Promise<void>;
}

/**
 * Validates and parses the horizontal shard allocation plan from the environment.
 *
 * Requirements:
 * - INDEXER_TOTAL_SHARDS must be a positive integer (>= 1).
 * - INDEXER_SHARD_ID must be an integer between 0 and TOTAL_SHARDS - 1.
 * - Multi-shard deployments automatically partition cursor storage keys by shard ID.
 */
export function parseShardPlan(env: Record<string, string | undefined> = process.env): ShardPlan {
  const totalShardsRaw = env.INDEXER_TOTAL_SHARDS ?? "1";
  const totalShards = parseInt(totalShardsRaw, 10);
  if (isNaN(totalShards) || totalShards < 1) {
    throw new Error(
      `INDEXER_HA_INVALID_CONFIG: INDEXER_TOTAL_SHARDS must be an integer >= 1 (got "${totalShardsRaw}")`
    );
  }

  const shardIdRaw = env.INDEXER_SHARD_ID ?? "0";
  const shardId = parseInt(shardIdRaw, 10);
  if (isNaN(shardId) || shardId < 0 || shardId >= totalShards) {
    throw new Error(
      `INDEXER_HA_INVALID_CONFIG: INDEXER_SHARD_ID must be an integer between 0 and ${totalShards - 1} (got "${shardIdRaw}")`
    );
  }

  const baseCursorKey = env.INDEXER_CURSOR_KEY ?? "ingestion";
  const cursorKey = totalShards > 1 ? `${baseCursorKey}:shard:${shardId}` : baseCursorKey;

  return { shardId, totalShards, cursorKey };
}

/**
 * Deterministically checks whether a market or event belongs to a given shard
 * using consistent hash partitioning.
 */
export function isMarketAssignedToShard(
  marketId: string,
  shardId: number,
  totalShards: number
): boolean {
  if (totalShards <= 1) return true;
  let hash = 5381;
  for (let i = 0; i < marketId.length; i++) {
    hash = ((hash << 5) + hash) ^ marketId.charCodeAt(i);
  }
  const posHash = Math.abs(hash);
  return posHash % totalShards === shardId;
}

/**
 * Loads and validates the Indexer HA configuration.
 */
export function loadIndexerHaConfig(
  env: Record<string, string | undefined> = process.env
): IndexerHaConfig {
  const enabled =
    env.INDEXER_HA_ENABLED !== undefined && env.INDEXER_HA_ENABLED !== ""
      ? env.INDEXER_HA_ENABLED === "true" || env.INDEXER_HA_ENABLED === "1"
      : true;

  const ttlMsRaw = env.INDEXER_LEASE_TTL_MS ?? "15000";
  const ttlMs = parseInt(ttlMsRaw, 10);
  if (isNaN(ttlMs) || ttlMs <= 0) {
    throw new Error(
      `INDEXER_HA_INVALID_CONFIG: INDEXER_LEASE_TTL_MS must be a positive integer (got "${ttlMsRaw}")`
    );
  }

  const renewIntervalRaw = env.INDEXER_LEASE_RENEW_INTERVAL_MS ?? "5000";
  const renewIntervalMs = parseInt(renewIntervalRaw, 10);
  if (isNaN(renewIntervalMs) || renewIntervalRaw === "" || renewIntervalMs <= 0) {
    throw new Error(
      `INDEXER_HA_INVALID_CONFIG: INDEXER_LEASE_RENEW_INTERVAL_MS must be a positive integer (got "${renewIntervalRaw}")`
    );
  }

  if (renewIntervalMs >= ttlMs) {
    throw new Error(
      `INDEXER_HA_INVALID_CONFIG: INDEXER_LEASE_RENEW_INTERVAL_MS (${renewIntervalMs}ms) must be less than INDEXER_LEASE_TTL_MS (${ttlMs}ms)`
    );
  }

  const prefix =
    env.REDIS_KEY_PREFIX !== undefined && env.REDIS_KEY_PREFIX !== ""
      ? env.REDIS_KEY_PREFIX
      : "vatix:";

  const shardPlan = parseShardPlan(env);

  return {
    enabled,
    ttlMs,
    renewIntervalMs,
    keyPrefix: prefix,
    shardPlan,
  };
}

/**
 * Distributed leader lease for Indexer HA replicas.
 *
 * Uses atomic Redis CAS operations with fencing tokens:
 * - Only the elected leader runs event ingestion on a given shard.
 * - Standby replicas monitor the lease and can serve read-only HTTP queries.
 * - When the leader disconnects or is stopped, standby takes over automatically.
 * - Enforces fail-closed: if Redis becomes unreachable and local TTL expires,
 *   the instance immediately ceases leader activities to avoid split-brain writes.
 */
export class IndexerLeaderLease {
  readonly holderId: string = randomUUID();
  readonly shardId: number;
  readonly totalShards: number;
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private readonly lockKey: string;
  private readonly fencingKey: string;
  private readonly redisClient: IndexerRedisClient;
  private token = 0;
  private expiresAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private callbacks: LeaderLeaseCallbacks = {};
  private inFlightTick: Promise<void> | null = null;

  constructor(
    config?: Partial<IndexerHaConfig>,
    redisClient?: IndexerRedisClient
  ) {
    const fullConfig: IndexerHaConfig = {
      ...loadIndexerHaConfig(),
      ...(config as any),
      shardPlan: {
        ...loadIndexerHaConfig().shardPlan,
        ...(config?.shardPlan ?? {}),
      },
    };
    this.shardId = fullConfig.shardPlan.shardId;
    this.totalShards = fullConfig.shardPlan.totalShards;
    this.ttlMs = fullConfig.ttlMs;
    this.renewIntervalMs = fullConfig.renewIntervalMs;
    this.lockKey = `${fullConfig.keyPrefix}indexer:leader:lock:shard:${this.shardId}`;
    this.fencingKey = `${fullConfig.keyPrefix}indexer:leader:fencing:shard:${this.shardId}`;
    this.redisClient = redisClient ?? (redis as unknown as IndexerRedisClient);

    indexerLeaderGauge.set({ shard_id: String(this.shardId) }, 0);
  }

  isLeader(): boolean {
    return this.token > 0 && Date.now() < this.expiresAt;
  }

  getToken(): number | null {
    return this.isLeader() ? this.token : null;
  }

  getLockKey(): string {
    return this.lockKey;
  }

  getFencingKey(): string {
    return this.fencingKey;
  }

  async start(callbacks: LeaderLeaseCallbacks = {}): Promise<void> {
    this.callbacks = callbacks;
    if (this.timer) return;

    await this.tick();

    this.timer = setInterval(() => {
      void this.tick();
    }, this.renewIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stopHeartbeat(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async release(): Promise<void> {
    this.stopHeartbeat();
    if (this.token > 0) {
      const { token, holderId, lockKey } = this;
      this.setNotLeader();
      try {
        await this.redisClient.releaseLeaseIfHeld(lockKey, holderId, token);
      } catch (error) {
        console.error(
          { service: "indexer-leader-lease", shardId: this.shardId, err: error },
          "Failed to release indexer leader lease on shutdown"
        );
      }
    }
  }

  private setNotLeader(): void {
    this.token = 0;
    this.expiresAt = 0;
    indexerLeaderGauge.set({ shard_id: String(this.shardId) }, 0);
  }

  private async tick(): Promise<void> {
    if (this.inFlightTick) return this.inFlightTick;
    this.inFlightTick = this.doTick();
    try {
      await this.inFlightTick;
    } finally {
      this.inFlightTick = null;
    }
  }

  private async doTick(): Promise<void> {
    if (this.token > 0 && Date.now() >= this.expiresAt) {
      this.handleLoss("local lease deadline passed before renewal succeeded");
    }

    const wasLeader = this.isLeader();

    try {
      const result = await this.redisClient.acquireOrRenewLease(
        this.lockKey,
        this.fencingKey,
        this.holderId,
        this.ttlMs,
        this.token
      );

      if (result > 0) {
        this.token = result;
        this.expiresAt = Date.now() + this.ttlMs;
        indexerLeaderGauge.set({ shard_id: String(this.shardId) }, 1);
        if (!wasLeader) {
          console.info(
            JSON.stringify({
              ts: new Date().toISOString(),
              level: "info",
              component: "indexer-leader-lease",
              message: "Acquired indexer leader lease",
              shardId: this.shardId,
              holderId: this.holderId,
              token: result,
            })
          );
          await this.callbacks.onAcquired?.(result);
        }
      } else {
        indexerLeaseRenewFailuresTotal.inc({ shard_id: String(this.shardId) });
        this.handleLoss("lease is held by another instance");
      }
    } catch (error) {
      indexerLeaseRenewFailuresTotal.inc({ shard_id: String(this.shardId) });
      console.error(
        {
          service: "indexer-leader-lease",
          shardId: this.shardId,
          err: error instanceof Error ? error.message : String(error),
        },
        "Failed to acquire/renew indexer leader lease"
      );
    }
  }

  private handleLoss(reason: string): void {
    if (this.token === 0) return;
    this.setNotLeader();
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        component: "indexer-leader-lease",
        message: "Lost indexer leader lease",
        shardId: this.shardId,
        holderId: this.holderId,
        reason,
      })
    );
    void this.callbacks.onLost?.(reason);
  }
}
