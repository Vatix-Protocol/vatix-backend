# Soft-Deleted Markets

**Invariant:** a market with `deleted_at IS NOT NULL` is invisible to, and
unusable by, every read and write path in this service. The row survives for
audit, but it behaves as if it does not exist. This is **deny-by-default**: a
path that forgets the filter is a bug, not a fallback, and there is no
environment (dev, staging, production) in which a soft-deleted market becomes
visible again.

Related: `SOFT_DELETED_MARKETS_CHANGES.md` (change summary),
`docs/architecture.md#market-lifecycle`, `SECURITY.md`.

## Why it matters

Soft delete (`Market.deletedAt`) exists so an admin can retire a market without
destroying the audit trail. If any path forgets `deletedAt: null`:

- a deleted market reappears in search/listing results,
- orders/positions can be created or settled against a retired market,
- the oracle can resolve and submit a dead market on-chain,
- admin/break-glass actions silently target a market operators believe is gone.

All four are money-path or security-relevant, so every path fails closed.

## Enforcement patterns

There are exactly two patterns. Use one of them; do not invent a third.

### 1. Query-level filtering (`findMany` / list endpoints)

```typescript
const where: Prisma.MarketWhereInput = {
  ...(status ? { status } : {}),
  ...(searchTerm
    ? { question: { contains: searchTerm, mode: "insensitive" } }
    : {}),
  deletedAt: null, // #1145 — always present, never conditional
};
```

`deletedAt: null` is a **literal key in every predicate**, not something a
caller can override. Optional filters (`status`, `q`, pagination) only narrow
the result set further. Indexed by `@@index([deletedAt])`.

### 2. Logic-level rejection (`findUnique` / by-id operations)

```typescript
const market = await prisma.market.findUnique({ where: { id } });
if (!market || market.deletedAt !== null) {
  throw new MarketNotFoundError(id); // or a 400 ValidationError for admin tools
}
```

`deletedAt !== null` deliberately treats `undefined` as deleted too (fail
closed if a projection ever omits the column).

## Covered surface

| Component                        | File                                                             | Pattern     |
| -------------------------------- | ---------------------------------------------------------------- | ----------- |
| Public market list + search      | `src/api/routes/markets.ts` (`GET /markets`)                     | query-level |
| Public market detail             | `src/api/routes/markets.ts` (`GET /markets/:id`)                 | logic-level |
| Public order book                | `src/api/routes/markets.ts` (`GET /markets/:id/orderbook`)       | logic-level |
| Admin market list / status patch | `src/api/routes/admin.ts`                                        | both        |
| Break-glass operations           | `src/services/break-glass.ts`                                    | logic-level |
| Audit chain verification         | `src/api/routes/audit-verification.ts`                           | logic-level |
| Matching validation + placement  | `src/matching/validation.ts`, `src/matching/matching-service.ts` | logic-level |
| Oracle poll loop                 | `apps/oracle/main.ts`                                            | both        |
| Indexer market routes            | `apps/indexer/src/**`                                            | both        |

## Market search (`GET /markets?q=…`) — #1145

`GET /markets` accepts an optional `q` parameter that matches the market
`question` case-insensitively (`contains` + `insensitive`):

```
GET /markets?q=bitcoin&status=ACTIVE&limit=20
```

Contract:

- `q` is trimmed; a whitespace-only term is treated as _no search_, not as a
  filter matching nothing.
- `q` must be 2–200 characters (schema-validated → `400` outside that range).
  The upper bound stops an adversarial caller from forcing a very wide scan;
  the lower bound avoids pathologically broad matches.
- Search **never** relaxes `deletedAt: null`. A soft-deleted market cannot be
  returned by any `q`, including an exact-question match.
- The raw search term is **never** logged or exported as a metric label — only
  the fact that a filtered query happened
  (`vatix_market_search_requests_total{filtered="true|false"}`). This keeps
  user-supplied text out of logs and metric cardinality bounded.
- The query runs inside the shared statement-timeout wrapper (#983); a slow
  scan sheds the request (`ServiceUnavailableError`) instead of pinning a pool
  connection.

## Observability

Metrics (`docs/metrics.md`):

- `vatix_market_search_requests_total{filtered}` — search vs. plain listing.

Logs:

- `market list query exceeded statement timeout` (warn) — includes the query
  object, never market contents and never the search term.

Alert ideas:

- Warning: any 5xx on `GET /markets` sustained for 5 minutes.
- Warning: `vatix_market_search_requests_total{filtered="true"}` flat while the
  clients report search traffic (silent route regression).

## Runbook

### Soft-delete a market

1. Confirm the market is not ACTIVE with open orders, or cancel it first.
2. `UPDATE markets SET deleted_at = now() WHERE id = '<marketId>';`
   (admin tooling preferred — it writes the audit entry.)
3. Verify: `GET /markets?q=<exact question>` and `GET /markets/<id>` must both
   stop returning the market (`404` / empty list).

### Suspected ghost (deleted market visible)

1. Identify the path: list, search, by-id, orderbook, matching, oracle.
2. Check that path for one of the two patterns above. A missing
   `deletedAt: null` in a `where` clause, or a missing `deletedAt !== null`
   guard, is the usual cause.
3. Fix, then add a regression test that asserts the _predicate_, not just the
   response body (the mocked-Prisma tests in
   `src/api/routes/markets.test.ts` are the template).
4. Do **not** "un-delete" a market to make a symptom disappear; that reverses
   the audit trail.

### Restore a soft-deleted market

Only via an explicit, audited admin action that clears `deletedAt` and records
why. There is no automatic restore path and no break-glass shortcut.

## Testing

- `src/api/routes/markets.test.ts` — search predicate, soft-delete invariant,
  `q` bounds, metrics labelling.
- `tests/integration/markets.test.ts` — end-to-end soft-deleted exclusion
  against a real database.
- `tests/deleted-markets-ghost-gap.test.ts`,
  `tests/deleted-markets-fixes.test.ts` — the original ghost-market regression
  suite.

## Rollback

The change is additive (an optional query parameter plus a new metric, #1145).
To roll back, revert the commit; no migration, flag, or data repair is needed.
Requests without `q` behave exactly as before.
