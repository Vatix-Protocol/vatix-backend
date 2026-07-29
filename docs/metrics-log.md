# Indexer Metrics Log

The indexer emits a structured metrics snapshot log on a regular heartbeat interval and on shutdown. This document describes the shape and usage of that log.

## Source

`apps/indexer/src/metrics.ts` — `InternalIndexerMetricsService`

## Log Event: `indexer.metrics.snapshot`

Emitted via `toLogFields()` whenever the indexer logs its current metrics state (startup, heartbeat, shutdown).

```json
{
  "event": "indexer.metrics.snapshot",
  "latestIndexedLedgerSequence": 1234567,
  "latestNetworkLedgerSequence": 1234617,
  "lag": 50,
  "gapDetectedTotal": 0,
  "backfillLedgersTotal": 0
}
```

| Field                           | Type                         | Description                                                                                                              |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `event`                         | `"indexer.metrics.snapshot"` | Fixed event tag for log filtering                                                                                        |
| `latestIndexedLedgerSequence`   | `number \| null`             | Sequence number of the last successfully indexed Stellar ledger. `null` until the first ledger is processed.             |
| `latestNetworkLedgerSequence`   | `number \| null`             | Latest ledger sequence reported by the Horizon/RPC node. `null` until the first tick.                                   |
| `lag`                           | `number \| null`             | Difference `latestNetworkLedgerSequence − latestIndexedLedgerSequence`. `null` when either value is unknown; floored at 0. |
| `gapDetectedTotal`              | `number`                     | Running count of ledger gaps detected since process start (within-window and cursor-level). Reset on restart.            |
| `backfillLedgersTotal`          | `number`                     | Running total of ledger ranges back-filled since process start. Reset on restart.                                        |

## Snapshot

`getSnapshot()` returns an `IndexerMetricsSnapshot` object for in-process use (e.g. health checks):

```ts
{
  latestIndexedLedgerSequence: number | null;
  latestNetworkLedgerSequence: number | null;
  lag: number | null;
  gapDetectedTotal: number;
  backfillLedgersTotal: number;
}
```

## Heartbeat

The ingestion loop emits a heartbeat log every 60 seconds containing the metrics snapshot alongside cursor position and batch counts. Filter logs by `event: "indexer.heartbeat"` to track liveness. The heartbeat also includes an `isPaused` flag that is `true` when the ingestion loop has been fail-closed by a large gap.

## Gap Detection Events

In addition to the metrics snapshot, the indexer emits dedicated structured log events when gap-related conditions occur:

| Log event                        | Level   | When emitted                                                                                 |
| -------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `indexer.gap.cursor_gap`         | `warn`  | Cursor jumped non-contiguously (e.g. manual move or skipped tick). Backfill is triggered.   |
| `indexer.gap.window_gap`         | `warn`  | One or more ledgers are absent from a successfully fetched event window. Backfill triggered. |
| `indexer.gap.backfill.start`     | `info`  | Back-fill operation starts; includes `gapStartLedger`, `gapEndLedger`, `backfillSize`.      |
| `indexer.gap.backfill.complete`  | `info`  | Back-fill finished; includes `eventsFound`, `written`, `skipped`.                           |
| `indexer.gap.clamped`            | `warn`  | Gap exceeded `INDEXER_BACKFILL_MAX_LEDGERS`; range was clamped.                             |
| `indexer.gap.pause`              | `error` | Gap met or exceeded `INDEXER_GAP_PAUSE_THRESHOLD`; loop is now fail-closed.                 |
| `indexer.gap.paused`             | `warn`  | Emitted on every subsequent tick while the loop is in fail-closed pause state.               |

## Alert Thresholds (recommended)

| Signal                    | Recommended alert condition          | Suggested action                                              |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| `lag`                     | `lag > 500` sustained for > 5 min    | Page on-call; check RPC connectivity and ingestion loop logs. |
| `gapDetectedTotal`        | Any increment                        | Review `indexer.gap.*` log events; verify backfill completed. |
| `indexer.gap.pause` event | Any occurrence                       | Immediate page; manual investigation and process restart.     |
| `indexer.gap.clamped`     | Any occurrence                       | Increase `INDEXER_BACKFILL_MAX_LEDGERS` or investigate root cause. |

## Related

- `apps/indexer/src/ingestion.ts` — drives the heartbeat and calls `setLatestIndexedLedgerSequence()`
- `apps/indexer/src/gapDetector.ts` — gap detection and bounded backfill implementation
- [Indexer Ledger Cursor](indexer-ledger-cursor.md)
