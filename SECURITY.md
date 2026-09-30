# Security Policy

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues.
Instead, report them responsibly by contacting security@vatix.io.

## Privileged Surfaces & Authz Policy

- **Deny-by-default**: Every external entrypoint requires an authenticated
  principal unless explicitly marked as a probe. Unauthenticated requests
  to data or money-path routes fail closed with `401 UNAUTHORIZED`.
- **CORS allowlist**: Browser origins are deny-by-default. In production
  `CORS_ALLOWED_ORIGINS` must list every allowed origin explicitly, as a bare
  `https://host[:port]` — `*` and `null` are rejected at startup because the
  API enables credentialed requests. Matching is exact (no implied
  subdomains) and rejected origins are never echoed into logs or responses.
  See [`src/api/middleware/README.md`](src/api/middleware/README.md).
- **Rate limiting**: Every external route is governed by an explicit policy in
  `RATE_LIMIT_POLICIES` (see `RATE_LIMIT_POLICY.md`). Routes without a policy
  are denied by default.
- **Probe safety**: Probe endpoints (`/health`, `/ready`) never return
  connection strings, credentials, hostnames, or internal addresses. Because
  probes are unauthenticated, every dependency failure is reduced to a
  sanitized summary plus a stable `code` by `sanitizeProbeMessage` before it
  reaches the response; the raw driver message is logged server-side only. See
  [`docs/health-probes.md`](docs/health-probes.md). Treat any value that has
  reached a probe response as public and rotate it.
- **Fail-closed dependencies**: If a critical dependency (database, Redis,
  RPC) is unreachable, probes return `503 DEPENDENCY_UNAVAILABLE` and money
  paths reject writes immediately rather than serving stale or degraded state.
- **Feature flags**: Money-path or mainnet-affecting changes must be gated
  behind a feature flag or kill-switch so they can be turned off without a
  redeploy (e.g. oracle [`ORACLE_DRY_RUN`](docs/oracle-dry-run.md), indexer
  `INDEXER_GAP_BACKFILL_ENABLED`).
- **Oracle money path**: the oracle signs and enqueues resolutions, so it is a
  privileged surface. Its invariants — a deadline on every price fetch, a
  bounded fallback chain that fails closed, a per-cycle deadline with
  exponential back-off, shutdown cancellation, and no credential in a log or
  metric label — are documented in
  [`apps/oracle/README.md`](apps/oracle/README.md), and `apps/oracle/main.test.ts`
  covers the poll pipeline (including the fail-closed paths) hermetically. The
  incident procedure is
  [Incident 5](docs/runbooks/incident-runbook.md#incident-5-oracle-resolution-failure).
- **Soft-deleted markets**: A soft-deleted market (`markets.deleted_at IS NOT
NULL`) is invisible to and unusable by every read and write path, including
  market search. `deletedAt: null` is a literal part of every market predicate
  and cannot be widened by a caller, including via the `q` search parameter.
  See [`docs/SOFT_DELETED_MARKETS.md`](docs/SOFT_DELETED_MARKETS.md).
- **Secret hygiene**: No secrets, passwords, or connection strings may be
  checked into the repository or emitted in structured logs.
