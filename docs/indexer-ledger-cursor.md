# Indexer Ledger Cursor

## Overview

The **ledger cursor** is the indexer's bookmark into the Stellar blockchain. It records the
sequence number of the last ledger successfully processed so the indexer can resume from the
correct position after a restart instead of re-scanning from genesis.

## How it works

1. On startup the indexer calls `PrismaCursorStorageClient.loadCursor()` to read the persisted
   sequence number from the `indexer_cursors` table in PostgreSQL.
2. Each ingestion tick fetches a ledger window via `EventFetcher`, parses events, writes them
   through `PrismaBatchWriter`, and advances the in-memory cursor to the window end **only after
   a successful batch write**.
3. The cursor is flushed to PostgreSQL every `checkpointFlushEveryBatches` successful batches
   (or immediately on shutdown).
4. The cursor value is a plain decimal string matching the Stellar ledger sequence number
   (e.g. `"1234567"`).

## Database schema

The cursor is stored in the `indexer_cursors` table with a composite primary key of
`(network_id, cursor_key)`. This allows multiple indexer consumers to coexist on the same
database — each with a distinct `cursor_key` — without clobbering one another.

| Column         | Type   | Description                                                |
| -------------- | ------ | ---------------------------------------------------------- |
| `network_id`   | string | Stellar network identifier (e.g. `"testnet"`)              |
| `cursor_key`   | string | Logical consumer name, configured via `INDEXER_CURSOR_KEY` |
| `cursor_value` | string | Last processed ledger sequence number                      |

Replay safety is provided by `indexer_processed_events.idempotency_key` (SHA-256 of
`{contractId}:{ledger}:{txIndex}:{eventIndex}`). Re-processing ledgers between checkpoints
inserts no duplicate rows.

## Configuration

| Variable                                 | Required | Default     | Description                                                                                                 |
| ---------------------------------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `INDEXER_CURSOR_KEY`                     | Optional | `ingestion` | Key used to namespace the cursor row. Change only when running multiple consumers against the same network. |
| `INDEXER_CONTRACT_ID`                    | Required | —           | Soroban contract ID to ingest (also accepts `MARKET_CONTRACT_ID`).                                          |
| `INDEXER_LEDGER_WINDOW_SIZE`             | Optional | `100`       | Ledgers scanned per ingestion tick (1–1000).                                                                |
| `INDEXER_BATCH_SIZE`                     | Optional | `100`       | Max events fetched per RPC page (1–500).                                                                    |
| `INDEXER_CHECKPOINT_FLUSH_EVERY_BATCHES` | Optional | `10`        | Successful batches between cursor checkpoints.                                                              |
| `INDEXER_GAP_PAUSE_THRESHOLD`            | Optional | `1000`      | Gap size (in ledgers) that triggers fail-closed pause. Set to `0` to disable.                               |
| `INDEXER_BACKFILL_MAX_LEDGERS`           | Optional | `500`       | Maximum ledgers re-fetched in a single backfill run. Larger gaps are clamped and warned.                    |
| `INDEXER_GAP_PAGING_WEBHOOK_URL`         | Optional | —           | Webhook URL to call when a persistent gap is detected. Required in production. In `production` mode without this, the indexer fails fast at startup. |
| `INDEXER_GAP_PERSISTENCE_CYCLES`         | Optional | `3`         | Number of consecutive detection cycles before paging operators (minimum: 1).                                 |

## Checkpoint flushing

The cursor is not written to the database on every tick — frequent small writes would create
unnecessary load. Instead it is flushed after a configurable number of successful batches
(`INDEXER_CHECKPOINT_FLUSH_EVERY_BATCHES`) and unconditionally on graceful shutdown.

## Reorg safety

When the Stellar network undergoes a chain reorganisation, ledgers that were
previously considered final may be replaced. The indexer detects reorgs and
rewinds its cursor to a safe depth so that forked events are re-fetched from
the canonical chain.

### Detection mechanism

1. After each successful ingestion tick the indexer calls the Stellar RPC
   `getLatestLedger()` endpoint and stores the **sequence number** and **hash**
   of the latest ledger in both memory and PostgreSQL (via
   `PrismaCursorStorageClient.saveLedgerHash()`).

2. On every subsequent tick, immediately after fetching the events window, the
   indexer compares the latest ledger from the RPC response against the stored
   values. A reorg is flagged when any of the following holds:

   - **Sequence regressed**: The current latest ledger sequence is **lower**
     than the last known sequence (the chain rolled back).
   - **Hash mismatch at same sequence**: The sequence is unchanged but the
     hash differs (the chain content changed without advancing the tip).

3. When a reorg is detected, the cursor is rewound by
   `ledgerWindowSize × 2` ledgers (never below 0). The current tick returns
   immediately without processing events; the next tick re-fetches from the
   rewound position.

```typescript
// apps/indexer/src/ingestion.ts (conceptual)
const rewindLedgers = ledgerWindowSize * REORG_REWIND_DEPTH_MULTIPLIER;
const safeSequence = Math.max(0, currentSeq - rewindLedgers);
// → cursor set to safeSequence, next tick re-fetches from there
```

### Cursor hash persistence

The hash is stored in the same `indexer_cursors` table using a derived cursor
key (`${cursorKey}:ledger_hash`). This allows the reorg detection to survive
a full restart of the indexer process. If no persisted hash is found on
startup, detection is deferred until the first successful tick establishes a
baseline.

### Test coverage

`apps/indexer/src/ingestion.test.ts` (`reorg detection` → `synthetic reorg
fixture — cursor rewind`) exercises this policy against a synthetic
`SYNTHETIC_REORG_FIXTURE` of two competing forks (`forkA`/`forkB`) that
report the **same ledger sequence with different hashes**:

- Ingesting fork A establishes the sequence+hash baseline.
- Ingesting fork B at the same sequence triggers the hash-mismatch branch
  (not the sequence-regression branch, which is covered separately) and
  rewinds the cursor without writing fork B's events.
- Once the chain advances past the fork point, the next tick re-fetches and
  persists fork B's canonical events — proving the rewind actually results
  in re-ingestion of the winning fork, not just a cursor decrement.

### Recovery

After a reorg rewind the indexer re-processes the affected ledgers. Any events
that were already persisted (trades, resolutions, deposits) are **skipped**
via `indexer_processed_events` idempotency keys — duplicate rows are never
inserted. Events that existed only on the forked branch are naturally absent
from the new window and produce no dust in the database.

```sql
-- The ledger hash is stored under a derived key
SELECT cursor_value FROM indexer_cursors
WHERE network_id = 'testnet' AND cursor_key = 'ingestion:ledger_hash';
```

If the cursor row is absent (e.g. first run, or after manual deletion) the indexer starts from
ledger 0 and scans forward. To reset the indexer to a specific ledger, delete or update the
`indexer_cursors` row directly in PostgreSQL.

**Crash between write and checkpoint:** Events in the un-checkpointed window are written to
PostgreSQL (trades → `indexed_trades`, resolutions → `resolution_candidates`) but the cursor
may still point to an earlier ledger. On restart the indexer re-fetches that window; duplicate
events are skipped via `indexer_processed_events` idempotency keys (`skipped` count increments,
no duplicate DB rows).

```sql
-- Reset to a specific ledger
UPDATE indexer_cursors
SET cursor_value = '1234567'
WHERE network_id = 'testnet' AND cursor_key = 'ingestion';

-- Remove the cursor entirely (restart from genesis)
DELETE FROM indexer_cursors
WHERE network_id = 'testnet' AND cursor_key = 'ingestion';
```

## Related source files

- `apps/indexer/src/storage.ts` — `PrismaCursorStorageClient` reads and writes the cursor
- `apps/indexer/src/ingestion.ts` — `PollingIngestionLoop` drives fetch → parse → write
- `apps/indexer/src/batchWriter.ts` — `PrismaBatchWriter` persists trades and resolutions
- `apps/indexer/src/gapDetector.ts` — `GapDetector` detects and back-fills ledger gaps
- `.env.example` — documents indexer environment variables

---

## Gap Detection and Watermark Reconciliation

Reorg rewind handles forked-chain scenarios. Gap detection handles a different failure mode:
ledgers that were **never ingested** — holes left by skipped ticks, partial batch failures,
Horizon page omissions, or manual cursor edits.

### Why gaps are production-critical

Missing ledgers mean missing trades, deposits, and resolutions with no user-visible error. The
gap detector provides the missing signal and automatically catches up within configurable bounds.

### How it works

After each successful ingestion batch the indexer runs two gap checks:

**1. Cursor-level gap** (before parsing)

Detects whether the cursor jumped non-contiguously. For example, if `lastIndexedLedger = 100`
but `batchStartLedger = 150`, ledgers 101–149 were skipped. The detector triggers a back-fill
for those ledgers before the current batch continues.

```
lastIndexedLedger = 100
batchStartLedger  = 150
→ gap: [101, 149] (49 ledgers)
```

**2. Within-window gap** (after successful batch write)

Compares the set of ledger sequences present in the fetched events against the full
`[startLedger, min(endLedger, networkTip)]` range. Any missing integer is flagged and
back-filled. Ledgers beyond the network tip are ignored (they haven't been produced yet).

```
startLedger = 101, endLedger = 110, networkTip = 200
seenLedgers = {101, 103, 104, 105, …, 110}  → 102 missing
→ gap: [102, 110]
```

### Bounded back-fill

Back-fills are performed by `GapDetector.runBackfill()`:

1. The gap range is clamped to `INDEXER_BACKFILL_MAX_LEDGERS` (default: 500). Wider gaps are
   partially back-filled; a `warn` log and the `indexer.gap.clamped` event are emitted.
2. Events are fetched via the existing `EventFetcher.fetchByLedgerWindow()` call.
3. Parsed events are written through `PrismaBatchWriter` → `withIdempotencyKey` →
   `indexer_processed_events`. Duplicate rows are never inserted — the operation is fully
   idempotent and safe to retry.
4. Metrics counters `gapDetectedTotal` and `backfillLedgersTotal` are incremented.

### Fail-closed threshold

When the raw gap size meets or exceeds `INDEXER_GAP_PAUSE_THRESHOLD` (default: 1000 ledgers),
the back-fill is **not** executed and the ingestion loop is fail-closed:

- An `error` log with event `indexer.gap.pause` is emitted.
- The `isPaused` flag is set on the loop instance.
- All subsequent ticks are skipped and emit a `warn` log with event `indexer.gap.paused`.
- The heartbeat log includes `isPaused: true`.

Recovery requires an operator to investigate the root cause, optionally back-fill manually
(e.g. by lowering `INDEXER_GAP_PAUSE_THRESHOLD` temporarily), and restart the process.

Set `INDEXER_GAP_PAUSE_THRESHOLD=0` to disable fail-closed behaviour and allow unbounded
back-fills (subject to `INDEXER_BACKFILL_MAX_LEDGERS` clamping).

### Idempotency guarantee

Back-fills use the same `PrismaBatchWriter` → `indexer_processed_events` deduplication path
as normal ingestion. Each event is identified by its idempotency key
(`SHA-256({contractId}:{ledger}:{txIndex}:{eventIndex})`). Running a back-fill twice, or
running it after the events were already ingested by the normal flow, produces no duplicate
rows — the `skipped` counter increments and `written` stays at 0.

### Alert thresholds

| Signal                | Recommended condition   | Action                                                             |
| --------------------- | ----------------------- | ------------------------------------------------------------------ |
| `lag`                 | `lag > 500` for > 5 min | Check RPC connectivity; review ingestion logs.                     |
| `gapDetectedTotal`    | Any increment           | Review `indexer.gap.*` events; verify backfill completed.          |
| `indexer.gap.pause`   | Any occurrence          | Immediate page; manual investigation required before restart.      |
| `indexer.gap.clamped` | Any occurrence          | Increase `INDEXER_BACKFILL_MAX_LEDGERS` or investigate root cause. |

See [Metrics Log](metrics-log.md) for full log event reference.

### Test coverage

- `apps/indexer/src/gapDetector.test.ts` — unit tests for `detectGap`, `detectCursorGap`,
  `runBackfill` (including clamping, fail-closed, and metric increments).
- `apps/indexer/src/gap-detection.fixture.test.ts` — integration fixture:
  - Injected missing ledger detected within one poll cycle.
  - Backfill re-fetches the missing event.
  - Idempotency: second pass yields `written=0, skipped>0`.
  - Fail-closed: loop pauses when gap exceeds threshold.
