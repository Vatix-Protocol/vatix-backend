# Order/Trade Replay & Forensics

## Overview

`scripts/replay-market.ts` deterministically replays a market+outcome's full
order history through the real matching engine (`src/matching/engine.ts` /
`src/matching/orderbook.ts`) into a fresh, isolated `OrderBook`, then diffs
the result against ledger truth (`Order`/`Trade` rows) and the cached Redis
depth snapshot. It exits non-zero and prints a structured JSON report on any
divergence.

Hydrating only the currently-resting orders (what `matching-service.ts` does
on cold start) trusts `filledQuantity`/`status` as given — it can never catch
a historical fill-accounting bug, because it never re-derives a single fill.
Replay does: every trade in the report is recomputed from scratch by running
the same order arrivals through `matchOrder`, so any drift between "what the
engine would do" and "what actually got recorded" surfaces immediately.

## When to run it

- **After any matching-related incident or suspected data corruption**, before
  writing the postmortem — run it for every market+outcome touched in the
  incident window (`--as-of` the moment of the incident) to get an
  order-id-level account of what diverged.
- **Before enabling multi-instance matching** for a market, to confirm the
  current single-instance history replays clean.
- **Continuously in staging**, sampling a handful of markets, to catch a
  matching/fill-accounting regression as a metric trend rather than only
  during a live incident (see "Continuous sampling" below).

## Usage

```bash
# Show all flags
pnpm replay:market -- --help

# Single market + outcome, as of now
pnpm replay:market -- --market <marketId> --outcome YES
# (equivalently: npx tsx scripts/replay-market.ts --market <marketId> --outcome YES)

# As of a specific point in time (useful for incident postmortems)
pnpm replay:market -- --market <marketId> --outcome NO --as-of 2026-07-29T00:00:00Z

# Sample N markets (both outcomes) — for staging cron/continuous checks
pnpm replay:market -- --sample 20
```

| Flag                  | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `--market <id>`       | Market to replay                                                       |
| `--outcome <YES\|NO>` | Which side of the market to replay                                     |
| `--as-of <iso-date>`  | Replay only orders/trades at or before this instant (default: now)     |
| `--sample <N>`        | Replay N recent markets (both outcomes); non-zero exit if any diverges |
| `-h`, `--help`        | Print usage                                                            |

Required env: `DATABASE_URL` (and `REDIS_URL` for the depth cross-check).

Exit code is `0` when replay matches ledger truth (and the Redis snapshot, if
present) exactly, `1` on any divergence or error.

## Reconstructing a book's fills (incident recipe)

When ops needs an order-id-level account of what a book actually did — e.g. a
trader disputes a fill, or a matching incident is suspected:

1. **Fix the window.** Note the incident start/end and the affected
   `marketId`(s). Use the incident start as `--as-of` to replay the book as it
   was at that moment.
2. **Run the replay** for each affected `(marketId, outcome)` from an
   environment that can reach the production DB read replica (the script only
   issues reads, so it is safe against production):

   ```bash
   DATABASE_URL=... REDIS_URL=... \
     pnpm replay:market -- --market <marketId> --outcome YES --as-of <incidentStart>
   ```

3. **Read the JSON report** it prints on stdout (schema below). Exit `0` means
   the recorded fills are exactly what the engine would produce — the book
   reconstructs cleanly. Exit `1` means divergence; every field is keyed by
   order id.
4. **Triage divergence** with the field guide under "Interpreting a divergence
   report", checking `cancelAmbiguities` first (see "Known limitation: cancel
   timing").
5. **Attach the report** to the incident ticket / postmortem as the
   authoritative fill reconstruction.

The script is **read-only**: it only issues Prisma `findMany` reads and a
Redis `GET` for the cached depth snapshot. It never writes to the database or
cache, so it's safe to run against production.

## How it works

1. Loads every `Order` and `Trade` row for the given `(marketId, outcome)`
   with `createdAt`/`tradedAt <= --as-of`.
2. Builds an ordered event stream (`src/matching/replay.ts`): one `create`
   event per order (timestamped by `createdAt`), plus a `cancel` event for
   every `CANCELLED` order (see "Cancel timing" below for how it's placed).
3. Feeds the event stream through `replayEvents`, which calls the real
   `matchOrder` for every `create` event against the book built up so far —
   the same sequence `matching-service.ts#placeOrder` would drive in
   production, minus the DB/Redis/audit side effects.
4. Diffs (`src/matching/replay-diff.ts`) the replayed book/trades against:
   - the ledger's own `filledQuantity`/`status` per order,
   - the ledger's `Trade` rows (matched by `buyOrderId`/`sellOrderId`/
     `quantity`/`price`, not by trade id — see "Why not trade ids" below),
   - the cached Redis depth snapshot (`redis.getOrderBook`), if one exists —
     the 60s TTL means an idle market may have no cached snapshot; that's not
     itself a divergence, just a skipped check.

## Interpreting a divergence report

```jsonc
{
  "marketId": "...",
  "outcome": "YES",
  "orderMismatches": [
    {
      "orderId": "...",
      "field": "filledQuantity",
      "expected": 90,
      "actual": 60,
    },
  ],
  "missingOrderIds": [], // resting in the ledger, absent from the replayed book
  "extraOrderIds": [], // present in the replayed book, absent from the ledger
  "missingTrades": [], // recorded but never reproduced by replay
  "extraTrades": [], // reproduced by replay but never recorded
  "depthDeltas": [], // price-level quantity mismatches vs. the Redis cache
  "cancelAmbiguities": [], // cancels whose timing had to be approximated
  "hasDivergence": true,
}
```

- **`orderMismatches` (`filledQuantity`/`remaining`/`status`)** — the ledger's
  own bookkeeping disagrees with what the engine actually computed. This is
  the "fill accounting" bug class the tool exists to catch (e.g. a Trade
  upsert that silently no-op'd, or a double-applied fill).
- **`missingOrderIds` / `extraOrderIds`** — an order that should (or
  shouldn't) be resting isn't (or is). Points at hydration/cancel bugs.
- **`missingTrades` / `extraTrades`** — the set of trades the engine would
  produce from the order history doesn't match what's recorded. Points at a
  matching-algorithm bug (price-time priority, self-trade handling, etc.) or
  a bad cancel anchor (check `cancelAmbiguities` first).
- **`depthDeltas`** — the live Redis depth cache has drifted from ledger
  truth (e.g. the best-effort cache refresh in `placeOrder` silently failed —
  it's wrapped in a try/catch that only logs).
- **`cancelAmbiguities`** — not itself a divergence. Lists orders where cancel
  timing was approximated (see below); treat any _other_ divergence touching
  these order ids with extra scrutiny before declaring it a real bug.

## Known limitation: cancel timing

The `Order` table does not currently persist a cancellation timestamp — only
that a cancel happened, via `status: CANCELLED`. Exact interleaving of a
cancel against other orders arriving around the same time cannot be
reconstructed with certainty from that alone.

To stay safe rather than guess blindly, the CLI anchors each cancel event
immediately after the _last_ trade that touched the order (or immediately
after the order's own creation if it was never touched). This bounds the
replay's uncertainty to the window `(last fill, actual cancel]` — only an
order arriving in that narrow window could produce a false divergence, versus
the much larger error from assuming "cancelled instantly" or "cancelled at the
very end." Affected order ids are listed in `cancelAmbiguities`.

If cancel-related false positives become a recurring problem, the real fix is
adding a `cancelledAt` timestamp column and setting it in
`matching-service.ts#cancelOrder`'s transaction — out of scope here since this
tool is intentionally read-only against production.

## Why not compare by trade id

`matchOrder` stamps every trade with `Date.now()` captured at match time, and
the trade id embeds that timestamp. Replaying historical orders inevitably
captures a different `Date.now()` than the original request did, so trade ids
will differ even for a perfectly faithful replay. The diff instead compares
trades structurally, by `(buyOrderId, sellOrderId, quantity, price)`.

## Continuous sampling in staging

`--sample N` picks N markets and replays both outcomes for each, incrementing
the `vatix_replay_divergence_total` Prometheus counter
(`src/services/metrics.ts`) once per divergent book. Wire it into a staging
cron (e.g. hourly) to catch a matching/fill-accounting regression as a metric
trend:

```bash
npx tsx scripts/replay-market.ts --sample 20
```

## Golden test corpus

`src/matching/replay.test.ts` proves `replayEvents` reproduces byte-identical
trades to directly driving `matchOrder`/`OrderBook` for the same fill
scenarios as the existing `#729` snapshot corpus
(`src/matching/engine.fills.snapshot.test.ts`), plus a cancel scenario.

`src/matching/replay-diff.test.ts` proves a consistent corpus yields zero
diff, and that injected corruption (bad `filledQuantity`, a phantom/missing
order, a stale Redis depth snapshot) is detected with clear order-id-level
output.

## Audit Trail Verification API

In addition to replay-based forensics, the API provides audit trail verification endpoints under `/v1/admin/audit` for on-chain consensus verification:

### POST /v1/admin/audit/verify-chain

Verify hash chain integrity and detect tampering for a market's audit trail.

**Authentication**: Requires admin API key and admin role.

**Request**:

```json
{
  "marketId": "market-123",
  "startTime": "2026-07-29T00:00:00Z",
  "endTime": "2026-07-29T23:59:59Z"
}
```

**Response**:

```json
{
  "marketId": "market-123",
  "valid": true,
  "totalEvents": 1250,
  "mismatchCount": 0,
  "errors": [],
  "verifiedAt": "2026-07-29T12:00:00Z"
}
```

### GET /v1/admin/audit/watermark/:marketId

Get archival watermark for a market.

**Authentication**: Requires admin API key and admin role.

### GET /v1/admin/audit/events/:marketId

Get archived audit events for a market with pagination.

**Authentication**: Requires admin API key and admin role.

**Query parameters**:

- `limit`: Max events per page (default 100, max 1000)
- `offset`: Skip N events (default 0)
