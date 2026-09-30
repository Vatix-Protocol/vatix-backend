import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseShardPlan,
  isMarketAssignedToShard,
  loadIndexerHaConfig,
  IndexerLeaderLease,
  type IndexerRedisClient,
} from "./haCoordinator.js";

describe("haCoordinator — Shard Plan & Config (#1167)", () => {
  describe("parseShardPlan", () => {
    it("parses single-shard default configuration", () => {
      const plan = parseShardPlan({});
      expect(plan).toEqual({
        shardId: 0,
        totalShards: 1,
        cursorKey: "ingestion",
      });
    });

    it("parses multi-shard configuration with partitioned cursor key", () => {
      const plan = parseShardPlan({
        INDEXER_SHARD_ID: "2",
        INDEXER_TOTAL_SHARDS: "4",
      });
      expect(plan).toEqual({
        shardId: 2,
        totalShards: 4,
        cursorKey: "ingestion:shard:2",
      });
    });

    it("preserves custom cursor key in multi-shard mode", () => {
      const plan = parseShardPlan({
        INDEXER_CURSOR_KEY: "contract-events",
        INDEXER_SHARD_ID: "1",
        INDEXER_TOTAL_SHARDS: "3",
      });
      expect(plan).toEqual({
        shardId: 1,
        totalShards: 3,
        cursorKey: "contract-events:shard:1",
      });
    });

    it("throws when INDEXER_TOTAL_SHARDS is less than 1", () => {
      expect(() => parseShardPlan({ INDEXER_TOTAL_SHARDS: "0" })).toThrow(
        /INDEXER_HA_INVALID_CONFIG: INDEXER_TOTAL_SHARDS/
      );
      expect(() => parseShardPlan({ INDEXER_TOTAL_SHARDS: "-1" })).toThrow(
        /INDEXER_HA_INVALID_CONFIG: INDEXER_TOTAL_SHARDS/
      );
      expect(() => parseShardPlan({ INDEXER_TOTAL_SHARDS: "invalid" })).toThrow(
        /INDEXER_HA_INVALID_CONFIG: INDEXER_TOTAL_SHARDS/
      );
    });

    it("throws when INDEXER_SHARD_ID is out of bounds", () => {
      expect(() =>
        parseShardPlan({ INDEXER_SHARD_ID: "4", INDEXER_TOTAL_SHARDS: "4" })
      ).toThrow(/INDEXER_HA_INVALID_CONFIG: INDEXER_SHARD_ID/);

      expect(() =>
        parseShardPlan({ INDEXER_SHARD_ID: "-1", INDEXER_TOTAL_SHARDS: "2" })
      ).toThrow(/INDEXER_HA_INVALID_CONFIG: INDEXER_SHARD_ID/);

      expect(() =>
        parseShardPlan({ INDEXER_SHARD_ID: "abc", INDEXER_TOTAL_SHARDS: "2" })
      ).toThrow(/INDEXER_HA_INVALID_CONFIG: INDEXER_SHARD_ID/);
    });
  });

  describe("isMarketAssignedToShard", () => {
    it("assigns all markets to shard 0 when totalShards is 1", () => {
      expect(isMarketAssignedToShard("market-1", 0, 1)).toBe(true);
      expect(isMarketAssignedToShard("market-2", 0, 1)).toBe(true);
      expect(isMarketAssignedToShard("market-any-id", 0, 1)).toBe(true);
    });

    it("deterministically distributes markets across shards", () => {
      const totalShards = 3;
      const marketId = "test-market-123";
      const assignedShards: number[] = [];

      for (let s = 0; s < totalShards; s++) {
        if (isMarketAssignedToShard(marketId, s, totalShards)) {
          assignedShards.push(s);
        }
      }

      // Exactly one shard must claim this market
      expect(assignedShards).toHaveLength(1);
      // Repeating the check yields the same result
      expect(isMarketAssignedToShard(marketId, assignedShards[0], totalShards)).toBe(true);
    });
  });

  describe("loadIndexerHaConfig", () => {
    it("loads default HA configuration", () => {
      const config = loadIndexerHaConfig({});
      expect(config.enabled).toBe(true);
      expect(config.ttlMs).toBe(15_000);
      expect(config.renewIntervalMs).toBe(5_000);
      expect(config.keyPrefix).toBe("vatix:");
      expect(config.shardPlan.shardId).toBe(0);
      expect(config.shardPlan.totalShards).toBe(1);
    });

    it("supports disabling HA via INDEXER_HA_ENABLED=false", () => {
      const config = loadIndexerHaConfig({ INDEXER_HA_ENABLED: "false" });
      expect(config.enabled).toBe(false);
    });

    it("throws if renewIntervalMs >= ttlMs", () => {
      expect(() =>
        loadIndexerHaConfig({
          INDEXER_LEASE_TTL_MS: "5000",
          INDEXER_LEASE_RENEW_INTERVAL_MS: "5000",
        })
      ).toThrow(/must be less than INDEXER_LEASE_TTL_MS/);

      expect(() =>
        loadIndexerHaConfig({
          INDEXER_LEASE_TTL_MS: "4000",
          INDEXER_LEASE_RENEW_INTERVAL_MS: "5000",
        })
      ).toThrow(/must be less than INDEXER_LEASE_TTL_MS/);
    });

    it("throws on invalid TTL or renew interval", () => {
      expect(() => loadIndexerHaConfig({ INDEXER_LEASE_TTL_MS: "0" })).toThrow(
        /INDEXER_LEASE_TTL_MS must be a positive integer/
      );
      expect(() =>
        loadIndexerHaConfig({ INDEXER_LEASE_RENEW_INTERVAL_MS: "-10" })
      ).toThrow(/INDEXER_LEASE_RENEW_INTERVAL_MS must be a positive integer/);
    });
  });
});

describe("haCoordinator — IndexerLeaderLease (#1167)", () => {
  let mockRedis: IndexerRedisClient;

  beforeEach(() => {
    mockRedis = {
      acquireOrRenewLease: vi.fn(),
      releaseLeaseIfHeld: vi.fn().mockResolvedValue(true),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("constructs correct lock and fencing keys using shard ID and keyPrefix", () => {
    const lease = new IndexerLeaderLease(
      {
        keyPrefix: "custom:",
        shardPlan: { shardId: 2, totalShards: 4, cursorKey: "ingestion:shard:2" },
      },
      mockRedis
    );

    expect(lease.getLockKey()).toBe("custom:indexer:leader:lock:shard:2");
    expect(lease.getFencingKey()).toBe("custom:indexer:leader:fencing:shard:2");
    expect(lease.isLeader()).toBe(false);
    expect(lease.getToken()).toBeNull();
  });

  it("acquires lease, fires onAcquired, and reports isLeader=true", async () => {
    (mockRedis.acquireOrRenewLease as any).mockResolvedValueOnce(42);
    const onAcquired = vi.fn();
    const onLost = vi.fn();

    const lease = new IndexerLeaderLease(
      {
        ttlMs: 10_000,
        renewIntervalMs: 2_000,
        shardPlan: { shardId: 0, totalShards: 1, cursorKey: "ingestion" },
      },
      mockRedis
    );

    await lease.start({ onAcquired, onLost });

    expect(lease.isLeader()).toBe(true);
    expect(lease.getToken()).toBe(42);
    expect(onAcquired).toHaveBeenCalledWith(42);
    expect(onLost).not.toHaveBeenCalled();

    lease.stopHeartbeat();
  });

  it("handles lease held by another instance (standby replica)", async () => {
    (mockRedis.acquireOrRenewLease as any).mockResolvedValueOnce(-1);
    const onAcquired = vi.fn();
    const onLost = vi.fn();

    const lease = new IndexerLeaderLease(
      {
        shardPlan: { shardId: 1, totalShards: 2, cursorKey: "ingestion:shard:1" },
      },
      mockRedis
    );

    await lease.start({ onAcquired, onLost });

    expect(lease.isLeader()).toBe(false);
    expect(lease.getToken()).toBeNull();
    expect(onAcquired).not.toHaveBeenCalled();
    // onLost is not triggered on initial failed acquisition since it never held the lease
    expect(onLost).not.toHaveBeenCalled();

    lease.stopHeartbeat();
  });

  it("triggers onLost when an existing lease renewal fails", async () => {
    // 1st tick: acquires
    (mockRedis.acquireOrRenewLease as any).mockResolvedValueOnce(101);
    // 2nd tick: lost
    (mockRedis.acquireOrRenewLease as any).mockResolvedValueOnce(-1);

    const onAcquired = vi.fn();
    const onLost = vi.fn();

    const lease = new IndexerLeaderLease(
      {
        ttlMs: 10_000,
        renewIntervalMs: 100,
      },
      mockRedis
    );

    await lease.start({ onAcquired, onLost });
    expect(lease.isLeader()).toBe(true);

    // Call internal tick again
    await (lease as any).tick();

    expect(lease.isLeader()).toBe(false);
    expect(lease.getToken()).toBeNull();
    expect(onLost).toHaveBeenCalledWith("lease is held by another instance");

    lease.stopHeartbeat();
  });

  it("fails closed when local lease deadline passes before renewal", async () => {
    (mockRedis.acquireOrRenewLease as any).mockResolvedValueOnce(55);
    const onLost = vi.fn();

    const lease = new IndexerLeaderLease(
      {
        ttlMs: 50, // Short TTL
        renewIntervalMs: 200,
      },
      mockRedis
    );

    await lease.start({ onLost });
    expect(lease.isLeader()).toBe(true);

    // Wait until local deadline has passed
    await new Promise((res) => setTimeout(res, 70));

    // Next tick recognizes deadline passed before calling Redis
    (mockRedis.acquireOrRenewLease as any).mockRejectedValueOnce(new Error("Redis unreachable"));
    await (lease as any).tick();

    expect(lease.isLeader()).toBe(false);
    expect(onLost).toHaveBeenCalledWith(
      "local lease deadline passed before renewal succeeded"
    );

    lease.stopHeartbeat();
  });

  it("gracefully releases lease in Redis on shutdown", async () => {
    (mockRedis.acquireOrRenewLease as any).mockResolvedValueOnce(88);

    const lease = new IndexerLeaderLease(
      {
        keyPrefix: "test:",
        shardPlan: { shardId: 0, totalShards: 1, cursorKey: "ingestion" },
      },
      mockRedis
    );

    await lease.start();
    expect(lease.isLeader()).toBe(true);

    await lease.release();

    expect(lease.isLeader()).toBe(false);
    expect(mockRedis.releaseLeaseIfHeld).toHaveBeenCalledWith(
      "test:indexer:leader:lock:shard:0",
      lease.holderId,
      88
    );
  });

  it("simulates active-standby failover between two replicas", async () => {
    let currentHolder: { holderId: string; token: number } | null = null;
    let nextToken = 1;

    // In-memory simulation of Redis atomic lease
    mockRedis.acquireOrRenewLease = vi.fn(
      async (lockKey, fencingKey, holderId, ttlMs, knownToken) => {
        if (!currentHolder) {
          const token = nextToken++;
          currentHolder = { holderId, token };
          return token;
        }
        if (currentHolder.holderId === holderId && currentHolder.token === knownToken) {
          return currentHolder.token;
        }
        return -1;
      }
    );

    mockRedis.releaseLeaseIfHeld = vi.fn(async (lockKey, holderId, token) => {
      if (currentHolder && currentHolder.holderId === holderId && currentHolder.token === token) {
        currentHolder = null;
        return true;
      }
      return false;
    });

    const replica1 = new IndexerLeaderLease({}, mockRedis);
    const replica2 = new IndexerLeaderLease({}, mockRedis);

    // Replica 1 starts and acquires
    await replica1.start();
    expect(replica1.isLeader()).toBe(true);

    // Replica 2 starts and becomes standby
    await replica2.start();
    expect(replica2.isLeader()).toBe(false);

    // Replica 1 gracefully shuts down and releases lease
    await replica1.release();
    expect(replica1.isLeader()).toBe(false);

    // Replica 2 ticks and acquires leader lease (failover!)
    await (replica2 as any).tick();
    expect(replica2.isLeader()).toBe(true);

    replica2.stopHeartbeat();
  });
});
