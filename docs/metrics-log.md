# Indexer Metrics Log

The indexer emits a structured metrics snapshot log on a regular heartbeat interval and on shutdown. This document describes the shape and usage of that log.

## Source

`apps/indexer/src/metrics.ts` — `InternalIndexerMetricsService`

## Log Event: `indexer.metrics.snapshot`

Emitted via `toLogFields()` whenever the indexer logs its current metrics state (startup, heartbeat, shutdown).

```json
{
  "event": "indexer.metrics.snapshot",
  "latestIndexedLedgerSequence": 1234567
}
```

| Field                         | Type                         | Description                                                                                                  |
| ----------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `event`                       | `"indexer.metrics.snapshot"` | Fixed event tag for log filtering                                                                            |
| `latestIndexedLedgerSequence` | `number \| null`             | Sequence number of the last successfully indexed Stellar ledger. `null` until the first ledger is processed. |

## Snapshot

`getSnapshot()` returns an `IndexerMetricsSnapshot` object for in-process use (e.g. health checks):

```ts
{
  latestIndexedLedgerSequence: number | null;
}
```

## Heartbeat

The ingestion loop emits a heartbeat log every 60 seconds containing the metrics snapshot alongside cursor position and batch counts. Filter logs by `event: "indexer.heartbeat"` to track liveness.

## Related

- `apps/indexer/src/ingestion.ts` — drives the heartbeat and calls `setLatestIndexedLedgerSequence()`
- [Indexer Ledger Cursor](indexer-ledger-cursor.md)
