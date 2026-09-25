# Event Processor — Delivery Semantics (#980)

`src/services/event-processor.ts` (`EventProcessor`) consumes batches of
indexer events (on-chain trades, resolutions) and invokes a handler for each.

## Guarantee: at-least-once

**Delivery is at-least-once, never exactly-once.** The same event ID can be
delivered to the handler more than once:

| Cause                        | Why it re-delivers                                                            |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Process restart / crash      | The in-memory `seenEventIds` window is not persisted.                         |
| In-memory window eviction    | The window is bounded (`maxSeenEventIds`, default 100k); the oldest IDs drop. |
| Ledger replay / reorg        | The indexer re-emits events for a re-scanned ledger range.                    |
| Batch containing a duplicate | Skipped and counted, processing continues.                                    |

`DELIVERY_SEMANTICS` / `getDeliverySemantics()` both return `"at-least-once"`
and are covered by tests so this contract cannot silently regress.

## Handler contract

Handlers **MUST be idempotent**. Concretely, for `ResolutionCandidate`:

- Use an upsert or an `INSERT ... ON CONFLICT DO NOTHING` keyed by the event
  ID (or the `(marketId, ledgerSequence, txHash)` tuple).
- Never a bare `INSERT` — a redelivered event would create a duplicate
  `ResolutionCandidate`, which is the exact failure this issue tracks.
- A handler that throws is **not** marked processed, so the event is retried
  on the next batch that includes it. Make partial work safe to repeat.

## Two layers of dedup

1. **In-memory window** (`seenEventIds`) — best-effort fast path for recent
   replays within a single process lifetime. Not a source of truth.
2. **Durable store** (`EventProcessorOptions.persistentStore`) — an
   `EventDedupStore` backed by a DB table with a `UNIQUE` constraint on the
   event ID. Checked before the handler runs and written after it succeeds.
   This is what turns at-least-once _delivery_ into exactly-once _effects_.

## Production vs. dev split

- **`NODE_ENV=production`** — construct `EventProcessor` with a
  `persistentStore`. Without one, the constructor emits a structured
  `warn` log (`component: "event-processor"`) stating that exactly-once
  effects are not guaranteed.
- **Dev / test** — the in-memory window alone is fine; no store required.

## Observability

- Duplicate detections log at `warn` with `eventId`, `ledgerSequence`,
  `deliverySemantics`, and an optional `correlationId` argument threaded
  through `processBatch(events, handler, correlationId)`.
- Handler failures log at `error` with the same identifiers. Event payloads
  and secrets are never logged.
- `getTotalDuplicates()` exposes a cumulative duplicate counter for metrics.
