# Database Schema

Reference for the Vatix backend Postgres schema. The authoritative definition is
[`prisma/schema.prisma`](../prisma/schema.prisma); migrations live in
[`prisma/migrations/`](../prisma/migrations) and are applied with
`pnpm prisma:deploy`.

## Trade history indexes (#1144)

`trades` is the append-heavy table behind every user-facing history view. The
read paths are:

```sql
-- src/services/audit.ts — getWalletTradeHistory
WHERE (buyer_address = $1 OR seller_address = $1)
  [AND market_id = $2]
  [AND traded_at BETWEEN $3 AND $4]
ORDER BY traded_at DESC
LIMIT $5 OFFSET $6

-- src/services/audit.ts — getMarketTradeHistory
WHERE market_id = $1
  [AND traded_at BETWEEN $2 AND $3]
ORDER BY traded_at DESC
LIMIT $4 OFFSET $5
```

and the indexer's on-chain trade view:

```sql
-- apps/indexer/src/routes/markets.ts — GET /markets/:id/trades
-- keyset pagination, served from `indexed_trades` (not `trades`)
WHERE market_id = $1 [AND id > $2]
ORDER BY id ASC
LIMIT $3
```

Trade history is served from `indexed_trades` rather than `trades` because the
contract is the source of truth for what executed on-chain, while `trades` is a
local matching projection that can lag or be re-derived.

### Index inventory

| Index                                                    | Serves                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `trades_trade_id_key` (unique)                           | Idempotent re-ingest of a trade; lookup by the on-chain trade id.   |
| `trades_market_id_idx`                                   | Market-scoped filters that do not order by `traded_at`.             |
| `trades_buyer_address_idx` / `trades_seller_address_idx` | Per-column lookups from the `OR` predicate.                         |
| `trades_buyer_address_traded_at_idx`                     | One side of the per-wallet `OR`, already in `traded_at DESC` order. |
| `trades_seller_address_traded_at_idx`                    | The other side of the per-wallet `OR`.                              |
| `trades_traded_at_idx`                                   | Global "most recent trades" scans and date-window filters.          |
| **`trades_market_id_traded_at_idx`**                     | **Market-scoped history — added in #1144.**                         |
| `trades_settlement_status_idx`                           | Settlement reconciliation by state.                                 |
| **`trades_settlement_status_traded_at_idx`**             | **Unsettled trades oldest-first — added in #1144.**                 |

### Why the two new indexes

Both trade-history shapes end in `ORDER BY traded_at DESC`, and an index only
avoids a sort if it can return rows in the requested order.

- **Per-wallet history** was already covered: `buyer_address, traded_at DESC`
  and `seller_address, traded_at DESC` each match one branch of the `OR` and
  return rows in order, so Postgres does a `BitmapOr` and no sort.
- **Market-scoped history** was not. The only index with `market_id` leading
  was the single-column `trades_market_id_idx`, which Postgres can use to
  _find_ the rows but which carries no ordering — so every request additionally
  sorted the whole market's history before applying `LIMIT`. Deep history on a
  busy market degraded linearly. `trades_market_id_traded_at_idx` makes it a
  range scan that stops after `LIMIT` rows.
- **Settlement reconciliation** scans unsettled trades oldest-first. The
  single-column `settlement_status` index finds the rows but returns them in
  arbitrary order, so the queue again sorted before taking a batch.
  `trades_settlement_status_traded_at_idx` serves the scan in order.

### Operational notes

The migration creates both indexes with `CREATE INDEX CONCURRENTLY`, so it does
not take an `ACCESS EXCLUSIVE` lock on a live `trades` table. `CONCURRENTLY`
cannot run inside a transaction block, which is why this migration is a single
statement per index and is excluded from the transactional deploy path — run
it with `psql`, not through `prisma migrate deploy`, on any environment with
live traffic.

`CREATE INDEX CONCURRENTLY` can leave an `INVALID` index behind if it is
interrupted. Postgres will not use an invalid index, so a failed run is
performance-only and never a correctness problem; re-running the migration is
safe because it uses `IF NOT EXISTS`.

**Rollback** (run with `psql`, not through `prisma migrate deploy`):

```sql
DROP INDEX CONCURRENTLY IF EXISTS trades_market_id_traded_at_idx;
DROP INDEX CONCURRENTLY IF EXISTS trades_settlement_status_traded_at_idx;
```

Dropping an index is always safe for correctness — it only reintroduces the
sequential scans described above. Removing the rows from `schema.prisma`
alongside the indexes keeps the two from drifting.

## Related tables

| Table                | Purpose                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markets`            | Market definitions; `deleted_at` implements soft delete. Read APIs filter on `deleted_at IS NULL` so a deleted market is indistinguishable from a missing one. |
| `orders`             | Live order book.                                                                                                                                               |
| `trades`             | Matched trades written by the matching engine.                                                                                                                 |
| `indexed_trades`     | Idempotent on-chain event log written by the indexer (`idempotency_key` is unique).                                                                            |
| `trade_audit_events` | Append-only hash-chained audit log; `prev_hash`/`entry_hash` make tampering detectable.                                                                        |
| `positions`          | Per-wallet market position snapshot, upserted by the indexer.                                                                                                  |

## Conventions

- Money and settlement columns use explicit `@map` snake_case names; the
  `trades` / `orders` tables map to `trades` / `orders` with mapped columns.
- `price` and `quantity` on `trades` are `DECIMAL(10, 8)`, matching the
  on-chain `Decimal(20, 8)` representation after scaling.
- Soft deletes are expressed as `deleted_at IS NULL` rather than a boolean, so
  the deletion timestamp is retained for audit.
- Every table has a `created_at` defaulting to `now()`.
