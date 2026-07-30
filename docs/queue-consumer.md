# Queue Consumer

This document describes the generic queue consumer used by the workers module.

## Overview

The queue consumer lives in `apps/workers/src/consumers/queue-consumer.ts`. It processes jobs from a named queue, handles retries, and dead-letters jobs that exhaust all attempts. All log output uses structured fields at appropriate log levels so it integrates cleanly with the project's JSON logging pipeline.

## API

### `QueueJob`

Represents a single job pulled from the queue.

| Field      | Type                      | Description                          |
| ---------- | ------------------------- | ------------------------------------ |
| `id`       | `string`                  | Unique job identifier                |
| `payload`  | `Record<string, unknown>` | Arbitrary job data                   |
| `attempts` | `number`                  | Delivery attempt count (starts at 1) |

### `QueueConsumerConfig`

Configuration passed to `processJob`.

| Field                 | Type     | Description                                     |
| --------------------- | -------- | ----------------------------------------------- |
| `queueName`           | `string` | Logical queue name (e.g. `"settlement"`)        |
| `maxAttempts`         | `number` | Maximum delivery attempts before dead-lettering |
| `processingTimeoutMs` | `number` | Per-job processing timeout in milliseconds      |

### `JobHandler`

```typescript
type JobHandler = (job: QueueJob) => Promise<void>;
```

An async function that receives a job and either resolves (success) or throws (failure).

### `processJob(logger, config, job, handler)`

Processes a single job with structured logging and retry semantics.

```typescript
import { processJob } from "./consumers/queue-consumer.js";

await processJob(logger, config, job, async (job) => {
  // handle job.payload
});
```

## Log Levels

| Event                          | Level   |
| ------------------------------ | ------- |
| Job received                   | `info`  |
| Job completed successfully     | `info`  |
| Failure with retries remaining | `warn`  |
| Failure at max attempts        | `error` |

## Retry and Dead-Letter Flow

```
Job received
    │
    ▼
handler(job)
    │
    ├─ success ──► log info "Job processed successfully"
    │
    └─ error
           │
           ├─ attempts < maxAttempts ──► log warn "will retry", re-throw
           │
           └─ attempts >= maxAttempts ──► log error "max attempts exceeded", re-throw
                                              │
                                              ▼
                                       logDeadLetter(...)
```

When `processJob` re-throws after the final attempt, the caller is responsible for invoking [`logDeadLetter`](dead-letter-log.md) to record the terminal failure.

## Example

```typescript
import {
  processJob,
  type QueueConsumerConfig,
  type QueueJob,
} from "./consumers/queue-consumer.js";

const config: QueueConsumerConfig = {
  queueName: "settlement",
  maxAttempts: 3,
  processingTimeoutMs: 5_000,
};

const job: QueueJob = {
  id: "job-001",
  payload: { tradeId: "t-789" },
  attempts: 1,
};

await processJob(logger, config, job, async (j) => {
  // business logic here
});
```

## Settlement Worker

The settlement worker (`apps/workers/src/settlement/`) consumes the Redis settlement queue populated by `MatchingService` after each order match. It uses `processJob()` with dead-letter support and enforces idempotency on `tradeId`.

### Durable Delivery via Transactional Outbox

`MatchingService.placeOrder` does not enqueue settlement jobs directly. Every trade is written together with an `OutboxEvent` row in the same DB transaction, and delivery to this queue happens via a fast path (immediately after commit) plus a background recovery loop (`src/services/outbox-publisher.ts`, started by this worker's `bootstrap()`) that retries any row still unpublished. This guarantees a committed trade is never silently dropped, even if Redis is down or the process crashes between commit and enqueue. See [ADR 003 — Transactional Outbox for Settlement Delivery](adr/003-settlement-outbox.md) for the full design, metrics, and operator recovery commands.

### Environment Variables

| Variable                | Default             | Description                           |
| ----------------------- | ------------------- | ------------------------------------- |
| `SETTLEMENT_QUEUE_NAME` | `settlement-trades` | Redis stream name for settlement jobs |
| `REDIS_KEY_PREFIX`      | `vatix:`            | Key prefix applied to the stream name |

### `SettlementJob` Payload

| Field           | Type     | Description                               |
| --------------- | -------- | ----------------------------------------- |
| `tradeId`       | `string` | Unique trade identifier (idempotency key) |
| `marketId`      | `string` | Market the trade occurred in              |
| `outcome`       | `string` | Outcome side (`YES` / `NO`)               |
| `buyOrderId`    | `string` | Taker or maker buy order ID               |
| `sellOrderId`   | `string` | Taker or maker sell order ID              |
| `buyerAddress`  | `string` | Stellar address of the buyer              |
| `sellerAddress` | `string` | Stellar address of the seller             |
| `price`         | `string` | Execution price (stringified)             |
| `quantity`      | `string` | Matched quantity (stringified)            |
| `timestamp`     | `string` | Unix epoch milliseconds (stringified)     |

### Idempotency

Before processing, the worker atomically claims `settlement:processed:{tradeId}` in Redis via `SETNX`. If the key already exists the job is acknowledged and skipped. The lock is only meant to mark a _fully completed_ job — if the handler throws for any reason (transient RPC error, mid-transaction DB failure, permanent validation error), the lock is released (`DEL`) as part of error handling in `SettlementWorker.process()` before the error is re-thrown. This guarantees a legitimate retry (BullMQ redelivery) or a manual replay (`scripts/replay-dlq.ts`) actually reprocesses the trade instead of silently no-op'ing as "already processed" (#870).

### Transactional Settlement Apply (#870)

Once on-chain settlement succeeds (or immediately, if no Stellar config is present), the worker applies the terminal settlement state for that `tradeId` — `settlementStatus`, `settledAt`, `settlementTxHash` on the `trades` row — as a single Prisma transaction (`SettlementWorker.applySettlement`). The transaction reads the current row and writes the new state together; if the write fails partway through, the transaction rolls back and nothing is observably half-applied. The apply is idempotent: a trade already `SETTLED` is a no-op on redelivery.

### Error Classification → Retry / Quarantine (#870)

Every thrown error is classified via `classifySettlementError()` (`apps/workers/src/settlement/error-codes.ts`) into `transient`, `fatal`, or `invalid_input`. Only `transient` errors are retried by BullMQ's own backoff (`DEFAULT_JOB_OPTIONS`, 3 attempts). A `fatal` or `invalid_input` classification is **permanent**:

- The job is dead-lettered immediately (not only after `maxAttempts`).
- The worker throws a BullMQ `UnrecoverableError`, so the queue stops retrying immediately instead of burning the full backoff schedule on a message that cannot self-heal — this keeps a single poison job from occupying the worker's processing slot and delaying unrelated trades/markets behind it.
- The trade's `settlementFailureCount` is incremented; once it reaches `quarantineThreshold` (default `1`, configurable via `SETTLEMENT_QUARANTINE_THRESHOLD`), the trade is marked `QUARANTINED` with `quarantinedAt` and `settlementErrorCode` set.

A `QUARANTINED` trade is skipped on any future delivery (checked before the idempotency lock and before any Stellar RPC call) — quarantine is scoped to that one `tradeId`, so it never blocks jobs for other trades or markets.

### Inspecting and Replaying Quarantined Trades

Quarantined trades are queryable directly:

```sql
SELECT trade_id, market_id, settlement_status, settlement_error_code,
       settlement_failure_count, quarantined_at
FROM trades
WHERE settlement_status = 'QUARANTINED'
ORDER BY quarantined_at DESC;
```

The dead-letter entry for the same failure (Redis stream `{prefix}dead-letter:settlement`) carries the same `errorCode`/`classification` plus the original payload, for full context on why the trade was quarantined.

To safely replay after fixing the root cause (e.g. correcting a bad payload upstream, restoring Stellar account funding):

1. Confirm the underlying cause is resolved (check `settlement_error_code`).
2. Reset the row so the worker will process it again: `UPDATE trades SET settlement_status = 'PENDING', settlement_failure_count = 0, quarantined_at = NULL WHERE trade_id = '<tradeId>';`
3. Replay the dead-lettered job: `pnpm tsx scripts/replay-dlq.ts --queue settlement --dry-run` first to preview, then without `--dry-run` to re-enqueue.
4. Since quarantine re-triggers after `quarantineThreshold` permanent failures, a replay that hits the same root cause will quarantine again — treat repeated quarantine of the same `tradeId` as a signal to escalate rather than keep replaying.

### Flow

```
MatchingService.placeOrder()
    │
    └─ settlementQueue.enqueue(job)   ← fire-and-forget
           │
           ▼
      BullMQ queue (SETTLEMENT_QUEUE_NAME)
           │
           ▼
      settlement consumer (BullMQ Worker)
           │
           ├─ quarantine check (trades.settlementStatus === QUARANTINED)
           │       └─ quarantined → skip, ACK
           │
           ├─ idempotency check (SETNX settlement:processed:{tradeId})
           │       └─ already processed → ACK, skip
           │
           └─ processJob() → handler
                   ├─ success → applySettlement() [Prisma tx] → ACK
                   └─ error → classify (transient | fatal | invalid_input)
                         ├─ transient, attempts < maxAttempts → release lock, warn, retry
                         ├─ transient, attempts >= maxAttempts → release lock, logDeadLetter(), ACK
                         └─ fatal | invalid_input (permanent) → release lock,
                            recordPermanentFailure() [Prisma tx, may quarantine],
                            logDeadLetter(), throw UnrecoverableError → ACK (no further retries)
```

## Operating a Consumer: Start / Stop / Replay

### Start

```bash
# Settlement worker
pnpm workers:settlement:start        # one-shot
pnpm workers:settlement:dev          # watch mode, local dev

# Oracle submission worker
pnpm workers:oracle:start
pnpm workers:oracle:dev
```

### Stop

Workers shut down gracefully on `SIGTERM`/`SIGINT` — send the signal (e.g.
`Ctrl+C` locally, or the orchestrator's standard stop signal in production)
and the process finishes in-flight jobs before exiting. See
[Graceful Shutdown](graceful-shutdown.md).

### DLQ Replay Examples

Dead-lettered jobs live in Redis streams (`{REDIS_KEY_PREFIX}dead-letter:{queue}`)
and are replayed with `scripts/replay-dlq.ts`:

```bash
# Preview every DLQ entry across all queues, without re-enqueuing
pnpm tsx scripts/replay-dlq.ts --dry-run

# Replay only the settlement DLQ
pnpm tsx scripts/replay-dlq.ts --queue settlement

# Replay at most 10 entries from the oracle submission DLQ
pnpm tsx scripts/replay-dlq.ts --queue submission --limit 10

# Combine: preview the first 5 settlement entries before replaying for real
pnpm tsx scripts/replay-dlq.ts --queue settlement --limit 5 --dry-run
```

A successful replay re-enqueues the job to its original queue and removes the
dead-letter entry; a job that fails again is dead-lettered again on its next
terminal failure. For settlement specifically, reset any `QUARANTINED` trade
row first — see [Inspecting and Replaying Quarantined Trades](#inspecting-and-replaying-quarantined-trades)
above.

### Health Probes

Workers don't expose their own HTTP probes; consumer liveness is inferred from
the API's readiness endpoint, which checks the shared Redis/DB dependencies
the workers also rely on:

```bash
curl -s http://localhost:3000/v1/ready
curl -s http://localhost:3000/v1/health
```

`/v1/health` confirms the HTTP server is alive; `/v1/ready` additionally checks
database and indexer health before traffic is routed. Neither endpoint is
rate-limited (see [RATE_LIMIT_POLICY.md](../RATE_LIMIT_POLICY.md)), so they are
safe to poll frequently from an orchestrator or monitoring probe.

## Related Documentation

- [Dead Letter Log](dead-letter-log.md) — What happens after max retries
- [Graceful Shutdown](graceful-shutdown.md) — Worker shutdown patterns
- [Logger](logger.md) — Structured logging conventions
- [Architecture Overview](architecture.md) — How workers fit into the system
