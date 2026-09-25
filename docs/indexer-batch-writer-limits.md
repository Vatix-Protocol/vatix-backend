# Indexer Batch Writer Limits (#1152)

Size and input guard in front of the indexer's transactional write path.
Implemented in [`apps/indexer/src/batchWriter.ts`](../apps/indexer/src/batchWriter.ts).

## Why

`PrismaBatchWriter.write()` opens a single Postgres transaction over every
record it is handed — ingestion batches _and_ gap back-fill batches. With no
cap, a misbehaving or hostile producer could hand it an arbitrarily large array,
turning one call into an unbounded transaction (memory, lock time, replication
pressure) and effectively a denial of service against the write path that every
trade, resolution, and collateral deposit depends on.

## Behaviour

- **Hard record cap per `write()` call.** Default `1000`
  (`DEFAULT_MAX_BATCH_RECORDS`), overridable per instance via
  `new PrismaBatchWriter(logger, { maxRecords })` or globally via
  `INDEXER_BATCH_MAX_RECORDS`.
- **Guard runs before any database work.** An oversized batch throws
  `BatchWriteError` with `code: BATCH_WRITE_TOO_LARGE` and a `correlationId`;
  `$transaction` is never invoked, so nothing is opened or partially written.
- **Non-array payloads fail closed** with `BATCH_WRITE_INVALID_INPUT`.
- **Malformed configuration never disables the guard.** A blank, non-integer,
  zero, or negative `INDEXER_BATCH_MAX_RECORDS` falls back to the default cap
  (fail closed, never fail open).
- **Shared rule.** `assertBatchWithinLimits(records, opts)` is exported so every
  batch-producing entrypoint (ingestion, gap back-fill, operator scripts) can
  pre-check with exactly the rule the writer enforces.

New error codes join the existing stable set in `BatchWriteErrorCode`:

| Code                                 | Meaning                                | Retryable            |
| ------------------------------------ | -------------------------------------- | -------------------- |
| `BATCH_WRITE_TOO_LARGE`              | Record count exceeds the cap           | No (split the batch) |
| `BATCH_WRITE_INVALID_INPUT`          | Not an array / bad `maxRecords` config | No                   |
| `BATCH_WRITE_DEPENDENCY_UNAVAILABLE` | DB unreachable/timed out (existing)    | Yes                  |
| `BATCH_WRITE_FAILED`                 | Transaction failed (existing)          | Yes                  |

The error class lives in
[`batchWriterError.ts`](../apps/indexer/src/batchWriterError.ts) (re-exported
from `batchWriter.ts`) so consumers can catch it without loading the
Prisma-backed writer and its `DATABASE_URL` validation at module load.

## Observability

`vatix_indexer_batch_rejected_total{reason}` counts rejections before
persistence, labelled `too_large` or `invalid_input`. A non-zero rate means an
upstream producer is sending oversized or malformed batches — alert on it. The
writer also logs `Batch write rejected by size guard` with `code`,
`correlationId`, `recordCount`, and `maxRecords` (no payloads, no secrets).

## Configuration

```bash
# Hard cap on records accepted per batch write. Default: 1000.
INDEXER_BATCH_MAX_RECORDS=1000
```

## Tests

`apps/indexer/src/batchWriter.size-guard.test.ts` covers cap resolution (default,
valid, and malformed env values), `assertBatchWithinLimits` accept/deny,
non-array rejection, the rejection metric, writer-level rejection _before_ the
transaction, construction-time `maxRecords` validation, and the empty-batch fast
path. Existing write/dedup/retry tests are unchanged.

## Rollback

Raise or unset `INDEXER_BATCH_MAX_RECORDS` and restart the indexer. The guard is
pure in-process validation — no schema, queue, or on-chain state.
