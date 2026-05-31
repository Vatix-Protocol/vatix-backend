# Indexer Ledger Cursor

## Overview

The **ledger cursor** is the indexer's bookmark into the Stellar blockchain. It records the
sequence number of the last ledger successfully processed so the indexer can resume from the
correct position after a restart instead of re-scanning from genesis.

## How it works

1. On startup the indexer calls `PrismaCursorStorageClient.loadCursor()` to read the persisted
   sequence number from the `indexerCursor` table in PostgreSQL.
2. Each ingestion tick advances the cursor by one ledger and calls `saveCursor()` every
   `checkpointFlushEveryBatches` successful batches (or immediately on shutdown).
3. The cursor value is a plain decimal string matching the Stellar ledger sequence number
   (e.g. `"1234567"`).

## Database schema

The cursor is stored in the `indexerCursor` table with a composite primary key of
`(networkId, cursorKey)`.  This allows multiple indexer consumers to coexist on the same
database — each with a distinct `cursorKey` — without clobbering one another.

| Column       | Type   | Description                                         |
|--------------|--------|-----------------------------------------------------|
| `networkId`  | string | Stellar network identifier (e.g. `"testnet"`)       |
| `cursorKey`  | string | Logical consumer name, configured via `INDEXER_CURSOR_KEY` |
| `cursor`     | string | Last processed ledger sequence number               |

## Configuration

| Variable             | Required | Default      | Description                                                      |
|----------------------|----------|--------------|------------------------------------------------------------------|
| `INDEXER_CURSOR_KEY` | Optional | `ingestion`  | Key used to namespace the cursor row. Change only when running multiple consumers against the same network. |

## Checkpoint flushing

The cursor is not written to the database on every tick — frequent small writes would create
unnecessary load.  Instead it is flushed after a configurable number of successful batches
(`checkpointFlushEveryBatches`) and unconditionally on graceful shutdown.  If the process
crashes between checkpoints the indexer will re-process a small number of ledgers, which is
safe because event ingestion is idempotent.

## Recovery

If the cursor row is absent (e.g. first run, or after manual deletion) the indexer starts from
ledger 0 and scans forward.  To reset the indexer to a specific ledger, delete or update the
`indexerCursor` row directly in PostgreSQL.

```sql
-- Reset to a specific ledger
UPDATE "indexerCursor"
SET cursor = '1234567'
WHERE "networkId" = 'testnet' AND "cursorKey" = 'ingestion';

-- Remove the cursor entirely (restart from genesis)
DELETE FROM "indexerCursor"
WHERE "networkId" = 'testnet' AND "cursorKey" = 'ingestion';
```

## Related source files

- `apps/indexer/src/storage.ts` — `PrismaCursorStorageClient` reads and writes the cursor
- `apps/indexer/src/ingestion.ts` — `PollingIngestionLoop` drives cursor advancement
- `.env.example` — documents the `INDEXER_CURSOR_KEY` variable
