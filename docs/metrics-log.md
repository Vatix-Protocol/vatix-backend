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

| Field                         | Type                         | Description                                                                                                                |
| ----------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `event`                       | `"indexer.metrics.snapshot"` | Fixed event tag for log filtering                                                                                          |
| `latestIndexedLedgerSequence` | `number \| null`             | Sequence number of the last successfully indexed Stellar ledger. `null` until the first ledger is processed.               |
| `latestNetworkLedgerSequence` | `number \| null`             | Latest ledger sequence reported by the Horizon/RPC node. `null` until the first tick.                                      |
| `lag`                         | `number \| null`             | Difference `latestNetworkLedgerSequence − latestIndexedLedgerSequence`. `null` when either value is unknown; floored at 0. |
| `gapDetectedTotal`            | `number`                     | Running count of ledger gaps detected since process start (within-window and cursor-level). Reset on restart.              |
| `backfillLedgersTotal`        | `number`                     | Running total of ledger ranges back-filled since process start. Reset on restart.                                          |

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

| Log event                       | Level   | When emitted                                                                                 |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `indexer.gap.cursor_gap`        | `warn`  | Cursor jumped non-contiguously (e.g. manual move or skipped tick). Backfill is triggered.    |
| `indexer.gap.window_gap`        | `warn`  | One or more ledgers are absent from a successfully fetched event window. Backfill triggered. |
| `indexer.gap.backfill.start`    | `info`  | Back-fill operation starts; includes `gapStartLedger`, `gapEndLedger`, `backfillSize`.       |
| `indexer.gap.backfill.complete` | `info`  | Back-fill finished; includes `eventsFound`, `written`, `skipped`.                            |
| `indexer.gap.clamped`           | `warn`  | Gap exceeded `INDEXER_BACKFILL_MAX_LEDGERS`; range was clamped.                              |
| `indexer.gap.pause`             | `error` | Gap met or exceeded `INDEXER_GAP_PAUSE_THRESHOLD`; loop is now fail-closed.                  |
| `indexer.gap.paused`            | `warn`  | Emitted on every subsequent tick while the loop is in fail-closed pause state.               |

## Correlation IDs

Every structured log line and metric emitted by the indexer carries a `correlationId` so a single request, tick, or backfill can be traced end-to-end across the API, indexer, and worker processes.

- The API accepts an inbound `x-correlation-id` header and propagates it on outbound calls (RPC, DB, queue). When the header is absent, the entrypoint generates a new id.
- The indexer adopts the `correlationId` from the triggering message/tick and includes it on every `indexer.*` event, including `indexer.metrics.snapshot`, `indexer.heartbeat`, and all `indexer.gap.*` events.
- Correlation ids are opaque, non-secret identifiers. They must never contain tokens, credentials, wallet addresses, or PII.

## Error Codes

Structured error logs use a stable `errorCode` field so alerts and runbooks can key off a fixed value rather than a free-form message. Codes are namespaced by surface (e.g. `INDEXER_GAP_PAUSE`, `INDEXER_BACKFILL_CLAMPED`, `INDEXER_RPC_UNAVAILABLE`) and are treated as part of the public contract: renaming a code is a breaking change and must be called out in the PR.

- `errorCode` is always present on `error`-level events and on any event that fails closed.
- `message` is human-readable and may change; `errorCode` is the stable key for dashboards and alerts.
- Error logs include `correlationId` so a failing code can be joined back to the originating request or tick.

## Secret Redaction Invariants

Observability must never become a data-exfiltration path. The following invariants are enforced for every log line and metric label:

- No secrets, tokens, API keys, private keys, seed phrases, or credentials are ever written to logs or metric labels.
- No wallet addresses, account ids, or other PII are used as metric label values; use bounded enums (e.g. `status`, `errorCode`) instead.
- Metric label cardinality is bounded — never label by unbounded values such as ledger sequence, cursor, or correlation id.
- New privileged surfaces are deny-by-default: they emit no sensitive fields until explicitly reviewed, and any new log field must be justified in the PR.
- Redaction is applied at the logger boundary, so a field added upstream cannot leak by accident.

## Fail-Closed Observability

Observability is part of the safety model, not just a convenience. When a dependency is unavailable, the system fails closed and the failure is observable:

- **RPC / Horizon outage:** the indexer stops advancing the cursor, emits `INDEXER_RPC_UNAVAILABLE` with `correlationId`, and the `lag` metric rises. Writes are not attempted against stale data.
- **DB outage:** writes fail closed; the indexer does not acknowledge or advance past the failed batch. The failure is logged with a stable `errorCode` and surfaced via the heartbeat.
- **Redis / queue outage:** idempotency keys cannot be checked, so writes are rejected rather than retried blindly. The rejection is logged with `correlationId`.

In all cases the process prefers to halt and alert over proceeding with unverified state.

## Idempotency & Replay

Writes on the critical path are idempotent and safe under concurrent or replayed requests:

- Each write carries an idempotency key derived from the originating request/tick; duplicate keys are detected and the second attempt is a no-op.
- Replayed messages are deduplicated before any state mutation; the dedup decision is logged with `correlationId` and a stable `errorCode` when a replay is rejected.
- Backfill ranges are idempotent: re-running a range re-writes the same rows without double-counting `backfillLedgersTotal`.
- Idempotency state is stored in Redis; if Redis is unavailable the write fails closed (see above) rather than risking a double-apply.

## Alert Thresholds (recommended)

| Signal                    | Recommended alert condition       | Suggested action                                                   |
| ------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `lag`                     | `lag > 500` sustained for > 5 min | Page on-call; check RPC connectivity and ingestion loop logs.      |
| `gapDetectedTotal`        | Any increment                     | Review `indexer.gap.*` log events; verify backfill completed.      |
| `indexer.gap.pause` event | Any occurrence                    | Immediate page; manual investigation and process restart.          |
| `indexer.gap.clamped`     | Any occurrence                    | Increase `INDEXER_BACKFILL_MAX_LEDGERS` or investigate root cause. |
| `errorCode` (any)         | New or rising rate               | Look up the code in the runbook; join by `correlationId`.          |

## Related

- `apps/indexer/src/ingestion.ts` — drives the heartbeat and calls `setLatestIndexedLedgerSequence()`
- `apps/indexer/src/gapDetector.ts` — gap detection and bounded backfill implementation
- [Indexer Ledger Cursor](indexer-ledger-cursor.md)
- [SECURITY.md](../SECURITY.md) — secret handling and deny-by-default policy
