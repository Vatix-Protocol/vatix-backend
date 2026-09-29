# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Vatix-Protocol, please report it responsibly.

- **Do not** open a public GitHub issue for security vulnerabilities.
- Email the maintainers or use GitHub's private vulnerability reporting.
- Include a clear description, reproduction steps, and impact assessment.
- We aim to acknowledge reports within 72 hours.

## Scope

This policy covers all packages in the Vatix-Protocol monorepo, including `vatix-backend` (`apps/api`).

## Secret Scanning

Secrets must never be committed to the repository or baked into images. This
is enforced fail-closed at multiple layers:

- **`.gitignore`**: `.env` and other secret-bearing files (`.env.*`, `*.pem`,
  `*.key`, etc.) are ignored so they cannot be staged or committed.
- **`.dockerignore`**: the same secret-bearing paths are excluded so they are
  never copied into build contexts or baked into images.
- **CI gate**: a secret-scanning step (gitleaks) runs on every push and pull
  request. It blocks merges when a secret is detected, exiting non-zero with a
  stable, documented failure so the check is required and reproducible.
- **Pre-commit hook**: the same scanner runs locally via the pre-commit hook so
  contributors catch secrets before pushing.

### Remediation

If a secret is detected (locally or in CI):

1. **Do not** push or merge the change. Remove the secret from the working tree.
2. **Rotate the credential immediately** — assume any committed secret is
   compromised, even if the commit was never merged.
3. If the secret already reached a remote branch, purge it from history
   (e.g. `git filter-repo`) and force-push the cleaned branch.
4. Add the offending path/pattern to `.gitignore` and `.dockerignore` if it is
   not already covered.
5. Re-run the scanner locally (`pre-commit run --all-files`) and confirm the CI
   gate passes before re-opening the PR.

Never paste secret values into issues, PRs, logs, or chat. Report suspected
leaks via security@vatix.io.

## Admin Routes Matrix

The backend exposes privileged admin surfaces. All admin routes are **deny-by-default**: a request is rejected unless the caller presents a valid session with the required role/scope. Untrusted clients cannot bypass policy by omitting or forging role claims.

| Route | Method | Required role/scope | Idempotency | Fail-closed behavior |
| --- | --- | --- | --- | --- |
| `/admin/routes` | GET | `admin:read` | N/A (read) | Returns `503` if the route registry is unavailable; never returns a partial matrix as authoritative. |
| `/admin/routes/:id` | GET | `admin:read` | N/A (read) | `404` for unknown ids; `503` on registry outage. |
| `/admin/routes` | POST | `admin:write` | Required (`Idempotency-Key`) | Rejects writes when DB/Redis/RPC dependencies are unavailable; no partial mutation. |
| `/admin/routes/:id` | PATCH | `admin:write` | Required (`Idempotency-Key`) | Rejects writes on dependency outage; optimistic-concurrency conflict returns `409`. |
| `/admin/routes/:id` | DELETE | `admin:write` | Required (`Idempotency-Key`) | Rejects deletes on dependency outage; no soft-delete without durable write. |

### Invariants

- **Authorization:** every admin entrypoint enforces the required role/scope server-side. Missing, expired, or wrong-role sessions return `401`/`403` with a stable error code and a correlation id.
- **Idempotency:** mutating admin routes require an `Idempotency-Key`; concurrent or replayed requests with the same key resolve to a single effect.
- **Fail-closed:** if a dependency (RPC/DB/Redis) is unavailable, writes are rejected rather than partially applied. Reads degrade explicitly and never present stale data as authoritative.
- **Observability:** admin operations emit metrics/logs with correlation ids. Secrets, tokens, and credentials are never logged.
- **Kill-switch:** money-path or mainnet-affecting admin changes are gated behind a feature flag with a documented rollback path.

### Error codes

| Code | Meaning |
| --- | --- |
| `ADMIN_UNAUTHORIZED` | Missing or expired session. |
| `ADMIN_FORBIDDEN` | Authenticated but lacking the required role/scope. |
| `ADMIN_IDEMPOTENCY_REQUIRED` | Mutating request without an `Idempotency-Key`. |
| `ADMIN_DEPENDENCY_UNAVAILABLE` | Dependency outage; write rejected (fail-closed). |
| `ADMIN_CONFLICT` | Optimistic-concurrency conflict on update. |

## Privileged Surfaces & Authz Policy

- **Deny-by-default**: Every external entrypoint requires an authenticated
  principal unless explicitly marked as a probe. Unauthenticated requests
  to data or money-path routes fail closed with `401 UNAUTHORIZED`.
- **JWT verification (verify-only)**: When JWT auth is used, tokens are
  verified only — never trusted from the client. Verification is fail-closed:
  - **Algorithm allowlist**: only explicitly configured algorithms are
    accepted; `none` and any unexpected `alg` are rejected
    (`JWT_ALG_NOT_ALLOWED`, 401).
  - **Signature**: the signature is always verified against the configured
    key/secret; verification failure is rejected (`JWT_SIGNATURE_INVALID`,
    401).
  - **Claims**: `iss`, `aud`, `exp`, `nbf`, and `iat` (with bounded clock
    skew) are validated; missing or invalid claims are rejected
    (`JWT_CLAIM_INVALID`, 401).
  - **Fail-closed**: missing, malformed, or expired tokens are rejected with
    stable error codes and a correlation id; no privileged surface is
    reachable without a verified token.
  - **Authz**: verified identity is still subject to deny-by-default
    role/scope checks; a valid token does not by itself grant access
    (`FORBIDDEN`, 403).
  - **Observability**: verify outcomes (success and failure reason) are
    counted and logged without ever emitting tokens, secrets, or PII.
- **Route inventory**: The authoritative OpenAPI/route inventory for the
  `vatix-backend` API surface (method, path, authz requirement, request/
  response shape, and stable error codes) lives in
  [`apps/api/README.md`](apps/api/README.md). Every route is listed there;
  routes absent from the inventory are denied by default and must not be
  exposed. See [`apps/api/README.md`](apps/api/README.md).
- **Provider allowlist**: Price feeds are deny-by-default when configured —
  `ORACLE_PRICE_PROVIDER_ALLOWLIST` admits only named providers, enforced at
  construction and before every fetch (`PRICE_PROVIDER_NOT_ALLOWED`, 403).
  See [`docs/price-provider-allowlist.md`](docs/price-provider-allowlist.md).
- **Oracle credentials**: Oracle signing keys and provider API credentials are
  loaded only from the environment (or a mounted secret store) and are never
  committed, logged, or returned by any endpoint. Configuration is validated
  fail-closed at startup: a missing, malformed, or placeholder credential
  aborts boot with `ORACLE_CREDENTIAL_INVALID` rather than starting in a
  degraded state. Credentials are redacted in structured logs and error
  payloads, and privileged credential surfaces are deny-by-default. See
  [`apps/oracle/oracle-config.ts`](apps/oracle/oracle-config.ts).
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
- **Outbound webhook SSRF guard**: The indexer's only outbound request to a
  configurable URL is the gap-paging webhook. No route accepts client-supplied
  webhook or callback URLs. The webhook URL is validated at startup (no
  embedded credentials; https and a public host in production) and its host is
  re-resolved and checked before every send. Redirects are refused, the call is
  time-bounded, and the URL is never logged (`WEBHOOK_URL_*` codes). See
  [`docs/indexer-gap-paging-webhook.md`](docs/indexer-gap-paging-webhook.md).
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

## Secrets

- Never commit secrets, tokens, or credentials to the repository.
- Never log secrets. Redact sensitive fields before emitting logs or metrics.

## Implementation Summary (archive/sync)

The authoritative description of the archive/sync implementation — its
invariants, entrypoints, error codes, and observability — lives in
[`IMPLEMENTATION_SUMMARY.md`](IMPLEMENTATION_SUMMARY.md). That document is the
source of truth for how the indexer archives and syncs chain state; this
section records the security invariants that summary must uphold.

### Invariants

- **Server/contract is the source of truth**: Balances, swaps, and admin
  state are authoritative on the server/contract. The indexer archive and
  sync paths are derived views only and must never be treated as the
  authority for money-path decisions.
- **Deny-by-default authz**: Every archive/sync entrypoint requires an
  authenticated principal with the correct role; unauthenticated or
  wrong-role requests fail closed (`401 UNAUTHORIZED` / `403 FORBIDDEN`).
- **Fail-closed writes**: If a critical dependency (database, Redis, RPC) is
  unreachable, archive/sync writes are rejected immediately rather than
  partially applied or served from stale state.
- **Idempotency**: Concurrent or replayed archive/sync requests are
  idempotent — replays must not double-apply state, and duplicate work is
  deduplicated by a stable correlation id.

### Observability

- Archive/sync money paths emit metrics and structured logs with a stable
  correlation id so operators can trace a request end to end.
- Logs and metrics never include secrets, credentials, connection strings,
  or raw provider payloads; identifiers are redacted or hashed.

### Feature flags & rollback

- Archive/sync changes that affect the money path or mainnet are gated behind
  a feature flag or kill-switch (e.g. `INDEXER_GAP_BACKFILL_ENABLED`) so they
  can be disabled without a redeploy.
- Every such change documents its rollback strategy in the PR description;
  disabling the flag restores the prior, known-good behavior.

### Related docs

- [`IMPLEMENTATION_SUMMARY.md`](IMPLEMENTATION_SUMMARY.md) — archive/sync
  implementation summary (source of truth).
- [`RATE_LIMIT_POLICY.md`](RATE_LIMIT_POLICY.md) — per-route rate-limit
  policies.
- [`apps/indexer/README.md`](apps/indexer/README.md) — indexer overview and
  runbook entrypoints.
- [`apps/indexer/src/INDEXER_CONFIG_VALIDATION_HARDENING.md`](apps/indexer/src/INDEXER_CONFIG_VALIDATION_HARDENING.md)
  — indexer config validation hardening.

## References

- `apps/api/README.md` — admin API surface and route documentation.
- `apps/api/routes/orders.ts` — reference pattern for typed entrypoints, error codes, and correlation ids.
