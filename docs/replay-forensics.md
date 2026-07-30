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
# Single market + outcome, as of now
npx tsx scripts/replay-market.ts --market <marketId> --outcome YES

# As of a specific point in time (useful for incident postmortems)
npx tsx scripts/replay-market.ts --market <marketId> --outcome NO --as-of 2026-07-29T00:00:00Z

# Sample N markets (both outcomes) — for staging cron/continuous checks
npx tsx scripts/replay-market.ts --sample 20
```

Exit code is `0` when replay matches ledger truth (and the Redis snapshot, if
present) exactly, `1` on any divergence or error.

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
