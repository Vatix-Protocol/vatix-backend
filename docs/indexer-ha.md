# Indexer High Availability (HA) & Sharding Architecture

## 1. Overview & Problem Statement

Running horizontal replicas of the Vatix Indexer is required for high availability (zero-downtime rolling upgrades and automatic failover). However, without coordination:
- Multiple indexers competing to write to the same database cursor cause lock contention, cursor rewinds, and duplicate event ingestion.
- Database transactions encounter serialization failures and out-of-order event processing.

To eliminate single points of failure without risking split-brain writes, the indexer implements a **Redis CAS Leader Lease** architecture with **horizontal sharding** (#1167).

---

## 2. High-Availability Architecture

### 2.1 Active-Standby Leader Election
For any given shard, multiple indexer replicas can run simultaneously:
- **Elected Leader**: Holds the Redis lease for the shard, actively runs the polling ingestion loop, fetches Soroban ledger events, and checkpoints the cursor to PostgreSQL.
- **Standby Replicas**: Continuously compete for/monitor the lease. While in standby mode, they do not ingest events but can serve read-only HTTP traffic (such as `/health`, `/metrics`, and `/markets`).
- **Failover**: If the leader crashes, is terminated for deployment, or gets partitioned from Redis, its local deadline expires and the Redis lease is released/expires. A standby replica immediately acquires the lease and resumes ingestion from the exact cursor checkpoint stored in PostgreSQL.

### 2.2 Fencing Tokens & Fail-Closed Safety
- **Fencing Tokens**: Every successful lease acquisition atomically increments a Redis counter (`indexer:leader:fencing:shard:${shardId}`) using Lua scripts.
- **Local Clock Deadline**: The leader mirrors the lease TTL locally (`Date.now() + ttlMs`). If a network blip or Redis outage prevents renewal past the local deadline, the leader fails closed immediately (`isLeader() = false`), ceasing ingestion ticks before another replica can assume leadership.
- **Safe Graceful Release**: On `SIGTERM` / `SIGINT`, the leader executes a compare-and-delete Lua script (`releaseLeaseIfHeld`), deleting the lock key only if the token still matches its own. This allows standby replicas to take over instantly without waiting out the full TTL.

---

## 3. Horizontal Sharding Plan

When network throughput requires horizontal scaling across multiple workers, the indexer partitions event processing across shards:

1. **Shard Allocation**:
   - `INDEXER_TOTAL_SHARDS`: The total number of partitions (e.g. `4`).
   - `INDEXER_SHARD_ID`: The zero-indexed identity of this specific replica (e.g. `0`, `1`, `2`, `3`).
2. **Partitioned Cursor Storage**:
   - Single-shard mode: uses base cursor key (default `ingestion`).
   - Multi-shard mode: uses partitioned cursor key `ingestion:shard:${shardId}`. Each shard independently checkpoints its highest processed ledger and state.
3. **Partitioned Leader Locks**:
   - Each shard elects its own leader independently:
     `{REDIS_KEY_PREFIX}indexer:leader:lock:shard:${shardId}`.
4. **Deterministic Event Assignment**:
   - Events and markets are partitioned deterministically using consistent hash partitioning (`hash(marketId) % totalShards === shardId`).

---

## 4. Configuration Reference

| Environment Variable | Type | Default | Description |
|---|---|---|---|
| `INDEXER_HA_ENABLED` | boolean | `true` | Enables active-standby leader election across indexer replicas. Set to `false` as a kill-switch for standalone mode. |
| `INDEXER_SHARD_ID` | integer | `0` | Shard index assigned to this replica (must satisfy `0 <= shardId < totalShards`). |
| `INDEXER_TOTAL_SHARDS` | integer | `1` | Total number of shards configured across the indexer cluster. |
| `INDEXER_LEASE_TTL_MS` | integer (ms) | `15000` | Lease duration in Redis. |
| `INDEXER_LEASE_RENEW_INTERVAL_MS` | integer (ms) | `5000` | Heartbeat interval for lease renewal. Must be less than `INDEXER_LEASE_TTL_MS`. |
| `INDEXER_CURSOR_KEY` | string | `ingestion` | Base storage key for cursor checkpoints. In multi-shard mode, suffixed with `:shard:${shardId}`. |
| `REDIS_KEY_PREFIX` | string | `vatix:` | Environment namespace prefix applied to all Redis lock and fencing keys (#1166). |

---

## 5. Observability & Runbook

### Prometheus Metrics
- `vatix_indexer_leader{shard_id="<id>"}`: Gauge set to `1` when the process holds the leader lease for its shard, `0` when in standby.
- `vatix_indexer_lease_renew_failures_total{shard_id="<id>"}`: Counter incremented on lease renewal failure (e.g. network partition or Redis outage).

### Alerting Rules
- **Split Brain Prevention**: Alert if `sum(vatix_indexer_leader{shard_id="0"}) > 1` (never expected due to Redis atomic CAS).
- **No Active Leader**: Alert if `sum(vatix_indexer_leader{shard_id="0"}) == 0` for longer than `2 * INDEXER_LEASE_TTL_MS` (indicates all replicas failed or Redis is down).
- **Renew Flapping**: Alert if `rate(vatix_indexer_lease_renew_failures_total[5m]) > 0.1` (network instability to Redis).

### Rollback Strategy
If Redis experiences extended degradation, set `INDEXER_HA_ENABLED=false` and run a single indexer replica per shard.
