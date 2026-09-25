# Security Policy

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues.
Instead, report them responsibly by contacting security@vatix.io.

## Privileged Surfaces & Authz Policy

- **Deny-by-default**: Every external entrypoint requires an authenticated
  principal unless explicitly marked as a probe. Unauthenticated requests
  to data or money-path routes fail closed with `401 UNAUTHORIZED`.
- **Provider allowlist**: Price feeds are deny-by-default when configured —
  `ORACLE_PRICE_PROVIDER_ALLOWLIST` admits only named providers, enforced at
  construction and before every fetch (`PRICE_PROVIDER_NOT_ALLOWED`, 403).
  See [`docs/price-provider-allowlist.md`](docs/price-provider-allowlist.md).
- **Poison quarantine**: Submission-queue items that keep failing are
  quarantined after a bounded number of attempts and can never be replayed
  back into the money path (`SUBMISSION_QUEUE_POISON`, non-retryable); queue
  capacity is bounded (`SUBMISSION_QUEUE_FULL`). See
  [`docs/submission-queue-poison-handling.md`](docs/submission-queue-poison-handling.md).
- **Write-path input guards**: Indexer batch writes are capped before any
  database work (`BATCH_WRITE_TOO_LARGE` / `BATCH_WRITE_INVALID_INPUT`) and
  gap back-fill is single-flight, bounded, and kill-switchable
  (`INDEXER_GAP_BACKFILL_ENABLED`). See
  [`docs/indexer-batch-writer-limits.md`](docs/indexer-batch-writer-limits.md)
  and [`docs/indexer-gap-backfill.md`](docs/indexer-gap-backfill.md).
- **Rate limiting**: Every external route is governed by an explicit policy in
  `RATE_LIMIT_POLICIES` (see `RATE_LIMIT_POLICY.md`). Routes without a policy
  are denied by default.
- **Probe safety**: Probe endpoints (`/health`, `/ready`) never return
  connection strings, credentials, hostnames, or internal addresses.
- **Fail-closed dependencies**: If a critical dependency (database, Redis,
  RPC) is unreachable, probes return `503 DEPENDENCY_UNAVAILABLE` and money
  paths reject writes immediately rather than serving stale or degraded state.
- **Feature flags**: Money-path or mainnet-affecting changes must be gated
  behind a feature flag or kill-switch so they can be turned off without a
  redeploy.
- **Secret hygiene**: No secrets, passwords, or connection strings may be
  checked into the repository or emitted in structured logs.
