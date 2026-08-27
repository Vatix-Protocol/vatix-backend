# ADR 003 — Transactional Outbox for Settlement Delivery

**Status:** Accepted
**Date:** 2026-07-30

---

## Context

`MatchingService.placeOrder` (`src/matching/matching-service.ts`) persists trades inside a
Prisma transaction, then — after that transaction commits — calls
`settlementQueue.enqueue()` (a Redis `XADD`, see `src/services/settlement-queue.ts`) once per
trade to hand the fill off to the settlement worker.

This is a classic **dual-write**: two independent systems (Postgres, Redis) are written to
sequentially with no shared transaction. If the process crashes, Redis is unreachable, or the
enqueue loop fails partway through a multi-trade match, the trade is durably committed to
Postgres but the corresponding settlement job never reaches the queue. The prior code logged
`settlement_enqueue_failed` and moved on — there was no automatic recovery path, so the trade
silently never settles until an operator notices and manually reconciles it.

## Decision

Introduce a **transactional outbox**: every trade write is paired with an `OutboxEvent` row
written in the **same** Prisma transaction as the `Trade` upsert. Delivery to the settlement
queue is decoupled from that transaction into two paths:

1. **Fast path** (`MatchingService.placeOrder`, post-commit): immediately attempts
   `publishOutboxRow()` for low latency in the common case.
2. **Recovery path** (`src/services/outbox-publisher.ts`, `startOutboxPublisher()`): a
   background loop, started by the settlement worker process
   (`apps/workers/src/settlement/consumer.ts`), that periodically drains any `OutboxEvent` row
   still `PENDING` or `FAILED` and retries it with exponential backoff.

Because the outbox row is committed atomically with the trade, **there is no window in which a
trade exists without a corresponding durable settlement intent** — a crash or Redis outage
between commit and enqueue just means the fast path fails and the row is picked up by the
recovery loop instead.

### Schema

```prisma
enum OutboxStatus {
  PENDING
  PUBLISHED
  FAILED
  QUARANTINED
}

model OutboxEvent {
  id            String       @id @default(uuid())
  tradeId       String       @unique @map("trade_id")
  payload       Json
  status        OutboxStatus @default(PENDING)
  attempts      Int          @default(0)
  lastError     String?      @map("last_error")
  nextAttemptAt DateTime     @default(now()) @map("next_attempt_at")
  publishedAt   DateTime?    @map("published_at")
  quarantinedAt DateTime?    @map("quarantined_at")
  createdAt     DateTime     @default(now()) @map("created_at")
  updatedAt     DateTime     @updatedAt @map("updated_at")

  @@map("outbox_events")
}
```

`outbox_events` / `published_at IS NULL` was already the table+predicate the admission-control
lag detector (`src/services/lag-detector.ts`, `getOutboxUnpublishedCount()`) expected and
gracefully degraded around before this table existed — this migration is that table, so the
existing lag-shedding admission control (`docs/ADMISSION_CONTROL_CONFIG.md`) now has real data
instead of always reading 0.

### Idempotency

- **Trade persistence** was already idempotent on `tradeId` (`tx.trade.upsert`).
- **Outbox row creation** is idempotent on `tradeId` (`tx.outboxEvent.upsert`), so retrying the
  whole `placeOrder` transaction (should Prisma ever retry it) never creates a duplicate row.
- **Publishing** (`publishOutboxRow`) is safe to call more than once for the same row: it
  `updateMany`s on `{ tradeId, status: { not: "PUBLISHED" } }`, so a duplicate call after the
  row is already `PUBLISHED` is a no-op on the DB side. It can still call
  `settlementQueue.enqueue()` twice for the same trade (e.g. the fast path and a concurrent
  drain both racing an unpublished row) — this is accepted as **at-least-once** delivery. The
  settlement consumer (`apps/workers/src/settlement/settlement-worker.ts`, #870) already
  idempotency-checks on `tradeId` before applying a position, so a duplicate enqueue never
  double-applies a settlement.

### Backoff, orphan detection, and quarantine

`publishOutboxRow` uses capped exponential backoff (`1s * 2^attempts`, capped at 60s) on
failure, tracked via `nextAttemptAt`.

**Orphan detection.** Rows that have failed at least `OUTBOX_ORPHAN_ATTEMPTS_THRESHOLD` times (default 5) are surfaced via the `vatix_settlement_outbox_orphaned_trades` gauge for alerting.

**Quarantine.** Rows that exceed `OUTBOX_QUARANTINE_ATTEMPTS_THRESHOLD` (default 10, configurable via env) are automatically moved to `QUARANTINED` status and stop retrying. A quarantined entry will never be retried by the drain loop; only explicit operator action (via the API or manual SQL) can move it back to `FAILED` for retry or mark it `PUBLISHED` to discard it. The `vatix_settlement_outbox_quarantine_transitions_total` counter tracks quarantine transitions, and `vatix_settlement_outbox_quarantined_entries` gauge tracks current quarantined count.

In production (`NODE_ENV=production`), quarantine is mandatory — a permanently-failing entry will not retry indefinitely.

## Metrics

All registered on the shared Prometheus registry (`src/services/metrics.ts`), scraped via
`GET /metrics`:

| Metric                                            | Type    | Meaning                                                          |
| ------------------------------------------------- | ------- | ---------------------------------------------------------------- |
| `vatix_settlement_outbox_depth`                   | Gauge   | Rows currently `PENDING` or `FAILED` (not yet published)         |
| `vatix_settlement_outbox_lag_seconds`             | Gauge   | Age of the oldest unpublished row                                |
| `vatix_settlement_outbox_publish_failures_total`  | Counter | Total failed publish attempts                                    |
| `vatix_settlement_outbox_orphaned_trades`         | Gauge   | Rows that have failed ≥ `OUTBOX_ORPHAN_ATTEMPTS_THRESHOLD` times |
| `vatix_settlement_outbox_quarantined_entries`     | Gauge   | Rows currently in `QUARANTINED` status                           |
| `vatix_settlement_outbox_quarantine_transitions_total` | Counter | Total rows moved to `QUARANTINED` status                    |

Suggested alert: page when `vatix_settlement_outbox_lag_seconds` exceeds a few minutes, or when
`vatix_settlement_outbox_orphaned_trades` is nonzero for an extended period — either indicates
the recovery loop is running but the settlement queue (or the worker process itself) is
unhealthy, not just a transient blip. Also page when `vatix_settlement_outbox_quarantined_entries`
is nonzero, as this indicates operator action is required.

## Operator Recovery

If the settlement worker process is down entirely (so `startOutboxPublisher()` never runs), the
outbox simply backs up — no trades are lost, they just wait. To manually verify or force a
drain during an incident:

```sql
-- How many trades are waiting?
SELECT status, count(*) FROM outbox_events WHERE status <> 'PUBLISHED' GROUP BY status;

-- Oldest unpublished row (drives the lag metric)
SELECT trade_id, status, attempts, created_at, last_error
FROM outbox_events
WHERE status <> 'PUBLISHED'
ORDER BY created_at ASC
LIMIT 20;
```

Restarting `apps/workers/src/settlement/consumer.ts` (`pnpm workers:settlement`) is sufficient
to resume draining — `startOutboxPublisher()` runs on an interval
(`OUTBOX_PUBLISHER_INTERVAL_MS`, default 2s) and requires no special flags. There is no
separate "replay" command: any row not `PUBLISHED` is automatically eligible for the next drain
cycle once `next_attempt_at` has passed.

To force an immediate retry of rows currently in backoff (e.g. right after fixing a Redis
outage, without waiting out the backoff window):

```sql
UPDATE outbox_events SET next_attempt_at = now() WHERE status IN ('PENDING', 'FAILED');
```

### Managing quarantined entries

Entries that exceed `OUTBOX_QUARANTINE_ATTEMPTS_THRESHOLD` (default 10) are moved to `QUARANTINED`
status and stop retrying. No automatic recovery is possible — only explicit operator action can
move a quarantined entry back to `FAILED` for retry or mark it `PUBLISHED` to discard it.

**Via admin API:**

```bash
# List quarantined entries
curl -H "X-API-Key: <admin-key>" \
  "https://api.vatix/v1/admin/outbox/quarantined?limit=50&offset=0"

# Retry a quarantined entry (moves to FAILED, next drain will attempt)
curl -X POST \
  -H "X-API-Key: <admin-key>" \
  "https://api.vatix/v1/admin/outbox/quarantined/{tradeId}/retry"

# Discard a quarantined entry (marks PUBLISHED, no settlement happens)
curl -X POST \
  -H "X-API-Key: <admin-key>" \
  "https://api.vatix/v1/admin/outbox/quarantined/{tradeId}/discard"
```

**Via SQL (if API is unavailable):**

```sql
-- View quarantined entries
SELECT trade_id, attempts, last_error, quarantined_at, payload
FROM outbox_events
WHERE status = 'QUARANTINED'
ORDER BY quarantined_at DESC;

-- Retry a quarantined entry
UPDATE outbox_events
SET status = 'FAILED', attempts = 0, next_attempt_at = now(), quarantined_at = NULL
WHERE trade_id = '<tradeId>';

-- Discard a quarantined entry
UPDATE outbox_events
SET status = 'PUBLISHED', published_at = now(), quarantined_at = NULL
WHERE trade_id = '<tradeId>';
```

Rows never need to be manually deleted — mark them `PUBLISHED` (discarded) instead so the
audit trail remains intact.

## Consequences

- `settlementQueue.enqueue()` (`src/services/settlement-queue.ts`) is unchanged; both the fast
  path and the recovery loop call it exactly as before. This ADR only changes how failures to
  reach it are recovered from — it does not change the queue's own transport.
- Every `placeOrder` transaction now does one extra upsert per trade; this is a small,
  well-indexed write and negligible next to the existing order/position writes in the same
  transaction.
- The settlement worker process is now also responsible for outbox drain; if that process is
  scaled to zero for an extended period, the outbox metric alerts (above) are the signal that
  settlement is silently backing up.
