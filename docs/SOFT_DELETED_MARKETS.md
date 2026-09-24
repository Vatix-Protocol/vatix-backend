# Soft-Deleted Markets

This document defines how Vatix treats **soft-deleted markets** across the
indexer, API, and settlement surfaces. It is the source of truth for the
invariants enforced by issue #1085 ("Soft-deleted markets filtered everywhere").

## Motivation

Markets are never hard-deleted from storage. Removing rows would break
historical references (trades, positions, settlements) and make replay/audit
impossible. Instead a market is **soft-deleted**: it stays in storage but is
excluded from every read/money path that surfaces markets to clients.

## Data model

A market record carries a first-class deletion status:

- `deletedAt: Date | null` — timestamp of soft-deletion, `null` when active.
- `status: 'active' | 'deleted'` — derived convenience field.

A market is considered **soft-deleted** when `deletedAt` is non-null (or
`status === 'deleted'`). Both fields are written atomically by the admin
delete endpoint; there is no partial state.

## Invariants

1. **Excluded by default.** Every listing, aggregation, and lookup path
excludes soft-deleted markets unless the caller explicitly opts in with
`includeDeleted: true` (admin-only).
2. **Single-market lookups fail closed.** Fetching a soft-deleted market by
id returns `404 MARKET_NOT_FOUND` (not the record).
3. **Fail-closed on unknown status.** If deletion status cannot be determined
(DB/Redis/RPC outage, missing field, decode error), the market is treated as
deleted and is **not** surfaced on any read or money path. Writes that depend
on market existence fail closed with `503 MARKET_STATUS_UNAVAILABLE`.
4. **Server is source of truth.** Clients cannot influence deletion status;
the indexer/DB is authoritative.
5. **No secrets in logs.** Deletion events are logged with market id and
correlation id only.

## Affected surfaces

- Indexer storage queries (market listings, aggregations, counts).
- Market routes: `GET /markets`, `GET /markets/:id`, and any nested
  market-bearing responses (orders, positions, trades).
- Any aggregation that counts or ranks markets (volume, liquidity, TVL).

## Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `MARKET_NOT_FOUND` | 404 | Market does not exist or is soft-deleted. |
| `MARKET_STATUS_UNAVAILABLE` | 503 | Deletion status could not be resolved; request failed closed. |

All errors include a `correlationId` for tracing.

## Opt-in for admins

Admin-only endpoints may pass `includeDeleted: true` to inspect soft-deleted
markets (e.g. for recovery/audit). This flag is denied by default for
untrusted clients and requires an authenticated admin role.

## Testing requirements

- Soft-deleted markets are excluded from listings and aggregations.
- Single-market lookup of a soft-deleted market returns `MARKET_NOT_FOUND`.
- Non-deleted markets are still returned unchanged.
- Unknown/unavailable deletion status fails closed on read and money paths.

## Rollback

Soft-deletion is additive and reversible: clearing `deletedAt` (and setting
`status` back to `active`) restores a market. No data is destroyed, so rollback
of the filtering change is a config/flag flip with no migration.
