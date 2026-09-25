# Indexer Gap Back-Fill Job (#1151)

Bounded, idempotent, kill-switchable catch-up for missing ledgers.
Implemented in [`apps/indexer/src/gapDetector.ts`](../apps/indexer/src/gapDetector.ts).

## Why

When the indexer's cursor jumps over ledgers (manual cursor move, crash between
write and checkpoint, non-contiguous poll), events are silently missing —
trades, resolutions, and collateral deposits that settlement and analytics
expect. The back-fill job closes those holes. Because it re-fetches and
re-writes money-path records, it also needs explicit guards: a malformed range,
an overlapping run, a dependency outage, or an operator wanting to stop catch-up
must all fail closed rather than advance the cursor past data that was never
written.

## Invariants

1. **Idempotent.** Writes go through `BatchWriter` → `withIdempotencyKey`, so
   replaying the same range after a crash inserts no duplicates.
2. **Bounded.** The range is clamped to `backfillMaxLedgers` per run with a
   warning (`indexer.gap.clamped`).
3. **Fail-closed pause.** A gap ≥ `gapPauseThreshold` returns
   `{ paused: true, pausedReason: "threshold" }`; the ingestion loop halts.
4. **Kill-switch.** `backfillEnabled: false` (config) or
   `INDEXER_GAP_BACKFILL_ENABLED=false` (env) performs **no fetch and no write**
   and reports `pausedReason: "disabled"`. Unrecognised values keep the job
   enabled — a typo must not silently stop gap catch-up.
5. **Single-flight.** A second `runBackfill` while one is in flight returns
   `pausedReason: "in_progress"` instead of double-fetching and racing paging.
6. **Dependency outage fails closed.** A `BATCH_WRITE_DEPENDENCY_UNAVAILABLE`
   from the writer returns `pausedReason: "dependency_unavailable"` — nothing
   was partially persisted and the cursor must not advance.
7. **Typed errors + correlation ids.** Malformed ranges throw
   `GapBackfillError` `GAP_BACKFILL_INVALID_RANGE` (non-retryable); unexpected
   failures throw `GAP_BACKFILL_FAILED` (retryable) with the same correlation id
   echoed in logs and metrics.

`BackfillResult` now always carries `correlationId`, plus `pausedReason` when
the run stopped short of a full catch-up.

## Observability

| Metric                                              | Meaning                                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `vatix_indexer_gap_detected_total`                  | Gaps seen (unchanged)                                                                                          |
| `vatix_indexer_backfill_ledgers_total`              | Ledgers successfully back-filled (unchanged)                                                                   |
| `vatix_indexer_gap_backfill_outcome_total{outcome}` | Terminal outcome per run: `completed`, `paused`, `disabled`, `in_progress`, `dependency_unavailable`, `failed` |

Alert on any non-`completed` outcome: `dependency_unavailable`/`failed` mean the
indexer is not catching up, `paused` means it deliberately halted and needs a
human.

Structured log events: `indexer.gap.backfill.start`,
`.complete`, `.disabled`, `.in_progress`, `.dependency_unavailable`,
`.failed`, `.invalid_range`, `.write_errors`.

## Configuration

```bash
# Kill-switch for the back-fill job. Default: enabled.
INDEXER_GAP_BACKFILL_ENABLED=false
```

Existing knobs (`INDEXER_GAP_PAUSE_THRESHOLD`, `INDEXER_GAP_BACKFILL_MAX_LEDGERS`,
`INDEXER_GAP_PAGING_WEBHOOK_URL`) are unchanged.

## Tests

`apps/indexer/src/gapDetector.backfill.test.ts` covers the kill-switch (config
and env), malformed/adversarial ranges, single-flight concurrency, dependency
outage fail-closed, unexpected-failure wrapping, threshold pause reason, clamped
completion, and the outcome metric. Existing detection/paging tests in
`gapDetector.test.ts` and `gap-detection.fixture.test.ts` are unchanged.

## Rollback

Set `INDEXER_GAP_BACKFILL_ENABLED=false` (or `backfillEnabled: false`) and
restart the indexer — no redeploy, no schema change. Removing the env var
restores the previous behaviour.
