# Security Policy

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues.
Instead, report them responsibly by contacting security@vatix.io.

## Privileged Surfaces & Authz Policy

- **Deny-by-default**: Every external entrypoint requires an authenticated
  principal unless explicitly marked as a probe. Unauthenticated requests
  to data or money-path routes fail closed with `401 UNAUTHORIZED`.
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
  redeploy (e.g. oracle [`ORACLE_DRY_RUN`](docs/oracle-dry-run.md), indexer
  `INDEXER_GAP_BACKFILL_ENABLED`).
- **Soft-deleted markets**: A soft-deleted market (`markets.deleted_at IS NOT
NULL`) is invisible to and unusable by every read and write path, including
  market search. `deletedAt: null` is a literal part of every market predicate
  and cannot be widened by a caller, including via the `q` search parameter.
  See [`docs/SOFT_DELETED_MARKETS.md`](docs/SOFT_DELETED_MARKETS.md).
- **Secret hygiene**: No secrets, passwords, or connection strings may be
  checked into the repository or emitted in structured logs.
