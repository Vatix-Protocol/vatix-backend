# Indexer

The indexer consumes Stellar ledger events and projects them into the
backend read models. It is the source of truth for ledger-derived state
(balances, swaps, settlement) and must fail closed whenever that source
of truth is unreachable.

## Gap detection

`src/gapDetector.ts` detects missing ledger ranges in the ingested event
stream. It is keyed on `ledgerSeq:eventIndex` so that replayed or
concurrent detection requests are idempotent.

### Invariants

- **Contiguous ranges produce no gap.** A stream with no missing
  `ledgerSeq` values reports `hasGap: false`.
- **Single and multi-ledger gaps are reported.** Any missing
  `ledgerSeq` between the observed minimum and maximum is surfaced with
  its `from`/`to` bounds.
- **Boundary gaps are reported.** Missing ledgers at the start or end of
  the observed window are included.
- **Adversarial and duplicate inputs are rejected or deduplicated.**
  Out-of-order, duplicated, and malformed entries never produce a false
  "no gap" result.
- **Fail closed on dependency outage.** If the RPC/DB/Redis source of
  truth is unreachable, detection must not report `hasGap: false`; it
  returns a stable error code instead.

### Error codes

| Code | Meaning |
| --- | --- |
| `GAP_DETECTION_SOURCE_UNAVAILABLE` | Source of truth (RPC/DB/Redis) unreachable; fail closed. |
| `GAP_DETECTION_INVALID_INPUT` | Malformed or adversarial input rejected. |
| `GAP_DETECTION_UNAUTHORIZED` | Caller lacks the required role. |

Every detection result carries a `correlationId` for tracing across the
indexer and backend logs. Logs and metrics never include secrets or raw
credentials.

### Fixtures

Deterministic vectors live in `fixtures/gap-detection-vectors.json` and
cover contiguous ranges, single/multi-ledger gaps, boundary gaps, and
adversarial/duplicate inputs. Unit tests in `src/gapDetector.test.ts`
assert the invariants above, including auth and idempotency negatives
(replayed and concurrent detection requests).

### Rollback

Gap detection is read-only and does not mutate money-path state. If a
regression is detected, disable the detector via its feature flag and
fall back to the previous behavior; no mainnet state is affected.

## Cursor durability

`src/storage.ts` provides `PrismaCursorStorageClient` for durable
checkpointing of the indexer's ledger cursor. The cursor is the
indexer's bookmark into the Stellar blockchain and must advance
monotonically.

### Invariants

- **Cursor advances monotonically.** `saveCursor` rejects any value
  that would regress the stored cursor, throwing `CursorConflictError`.
  This prevents replayed or out-of-order requests from rewinding the
  indexer.
- **Batch writes and cursor saves are atomic.** `saveCursorWithBatch`
  wraps both the event batch write and the cursor advance in a single
  Prisma `$transaction`. If either side fails, the entire transaction
  rolls back so the cursor never advances without the data being
  persisted.
- **Fail closed on storage errors.** If the database is unreachable,
  `saveCursor`, `saveLedgerHash`, and `saveCursorWithBatch` propagate
  the error up to the ingestion loop, which halts rather than
  silently skipping the checkpoint.
- **Concurrent writers are detected.** When `saveCursorWithBatch` is
  called with an `expectedPreviousCursor`, it verifies that the
  current DB value matches before advancing. If a concurrent writer
  has already advanced the cursor, a `CursorConflictError` is thrown
  and the batch is rolled back.
- **No secrets in logs or metrics.** Cursor values are ledger sequence
  numbers (non-sensitive). Ledger hashes are truncated in log output.

### Error codes

| Code | Meaning |
| --- | --- |
| `CURSOR_CONFLICT` | Concurrent writer advanced the cursor; batch rolled back. |
| `CURSOR_STORAGE_CONFIG_ERROR` | Storage path misconfigured; fail fast. |
| `CURSOR_REGRESSION_REJECTED` | Replayed request would regress the cursor; denied. |

### Rollback

Cursor durability is a read/write surface that affects the indexer's
watermark. If a regression is detected, the indexer can be rolled back
by manually resetting the cursor in the `indexer_cursors` table. No
mainnet state is corrupted by a cursor rollback — only already-indexed
events are re-fetched and deduplicated by the idempotency layer.

## Stellar Wave contributors

See `SECURITY.md` for the deny-by-default policy on privileged surfaces
and the rate-limit/authorization requirements for every external
entrypoint. New privileged surfaces must be authorized and rate-limited
before landing.
