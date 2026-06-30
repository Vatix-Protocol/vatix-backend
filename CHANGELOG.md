# Changelog

## Unreleased

- **[#610] Remove orphaned `EventProcessor` / integrate dedup** — Deleted the
  in-memory `EventProcessor` class and its test from `src/services/` (the file
  was never imported or wired into the production code path). Deduplication is
  fully handled at the DB boundary via `IndexerProcessedEvent` +
  `idempotency.ts`. Added `DuplicateStats` to `idempotency.ts` so callers can
  track cumulative inserted/duplicate counts for metrics and structured logging
  without the unbounded memory growth of the old in-memory `Set`.

- Public API routes are canonical under `/v1/*`. Update frontend clients
  (`apps/web`) and external integrations to use `/v1/health`, `/v1/ready`,
  `/v1/markets`, `/v1/orders`, `/v1/orders/user/:address`,
  `/v1/trades/user/:address`, and `/v1/wallets/:wallet/positions`.
- Legacy root aliases such as `/markets`, `/orders`, and
  `/positions/user/:address` return `308` with deprecation headers until
  `2027-01-01T00:00:00Z`, then return `404`.
