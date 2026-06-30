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
| `INDEXER_LEDGER_WINDOW_SIZE`             | Optional | `100`       | Ledgers scanned per ingestion tick.                                                                         |
| `INDEXER_CHECKPOINT_FLUSH_EVERY_BATCHES` | Optional | `10`        | Successful batches between cursor checkpoints.                                                              |

## Checkpoint flushing

The cursor is not written to the database on every tick — frequent small writes would create
unnecessary load. Instead it is flushed after a configurable number of successful batches
(`INDEXER_CHECKPOINT_FLUSH_EVERY_BATCHES`) and unconditionally on graceful shutdown.

## Recovery

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
- `.env.example` — documents indexer environment variables
