# Audit Archiver Retention

The audit archiver (`apps/workers/src/audit-archiver/`) drains every Redis
trade-stream entry into Postgres as a `trade_audit_events` row before the stream
is allowed to trim. Without a retention policy that table grows without bound —
a slow-motion disk-exhaustion incident on a money-path table.

Retention is therefore explicit, opt-in, and fail-closed.

## Configuration

| Env var                                  | Default | Meaning                                                                |
| ---------------------------------------- | ------- | ---------------------------------------------------------------------- |
| `AUDIT_ARCHIVE_RETENTION_DAYS`           | `0`     | Days of archived history to keep. **`0` disables retention entirely.** |
| `AUDIT_ARCHIVE_RETENTION_BATCH_SIZE`     | `1000`  | Max rows a single run may delete. Must be `>= 1`.                      |
| `AUDIT_ARCHIVE_RETENTION_MIN_PER_MARKET` | `1`     | Rows always kept per market. Must be `>= 1`.                           |

Invalid values (negative or non-numeric) make the worker **fail to boot** rather
than fall back to a guessed value — a typo in a destructive setting must not
silently widen the delete window.

The effective window is logged at startup as `retentionEnabled` / `retentionDays`
so you can confirm the destructive path is armed before it ever runs.

## Invariants

The policy is implemented as a pure planner, `planRetentionPurge` in
`retention.ts`, so it is unit-testable without a database.

1. **Fail-closed / opt-in.** `retentionDays <= 0` returns an empty plan. There
   is no "delete everything" sentinel — a large window is expressed in days.
2. **Prefix-only, per market.** Only a contiguous _oldest_ run of rows is
   eligible. A row is never deleted while a retained row in the same market
   still chains to it via `prevHash`.
3. **Never empty a market.** `retentionMinPerMarket` guarantees every market
   keeps a verifiable chain head.
4. **Bounded per run.** At most `retentionBatchSize` rows are deleted, so a large
   backlog drains across many polls instead of one long lock-holding transaction.
5. **Bounded window.** Only rows with `archivedAt < now - retentionDays` are
   eligible, so a purge can never race rows the current run just archived.

### Why prefix-only matters

`trade_audit_events` is a hash chain: each row stores `prevHash` (the previous
row's `entryHash`) and `entryHash = sha256(payload + prevHash)`. Verification in
`src/services/auditChain.ts` explicitly checks _linkage_, not just per-row hash
validity — a row deleted from the middle leaves every surviving row internally
consistent while breaking the chain, which is reported as a `chain_gap`.

Because retention necessarily removes the genesis end of the chain, verifying a
post-retention slice must pass `expectGenesis: false` (the first retained row is
anchored by the row before it, not by the root hash `"0"`). Deleting a strict
per-market prefix is what keeps that anchored slice contiguous.

## Observability

Each run logs:

- `Audit retention purge complete` — `purgedCount`, `requestedCount`,
  `marketCount`, `retentionDays`, `cutoff`
- `Audit retention purge failed` — retention is housekeeping and never fails an
  archival run; the archive is left untouched
- `Audit retention purged fewer rows than planned` — a concurrent run or
  operator removed rows between the scan and the delete

Per-poll results carry `purgedCount` and `retentionEnabled` so the archiver's
existing metrics surface retention progress.

## Rollback / kill-switch

Setting `AUDIT_ARCHIVE_RETENTION_DAYS=0` and restarting the worker disables all
deletes immediately. The kill-switch is the default state, so no rollback is
required to stop a purge in progress.

## Disputes and the restore drill

Retention trades history depth against disk growth. Before enabling it, confirm
the dispute/forensics path you depend on is either (a) inside the window, or
(b) covered by an off-box backup. See `docs/replay-forensics.md` for the
retention-sensitive parts of the audit story.

closes #1137
