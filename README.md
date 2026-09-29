# Vatix Protocol

Monorepo for the Vatix Protocol. Package focus: `vatix-backend`.

## Health vs. readiness probes

The backend exposes two distinct probe endpoints. They are intentionally
separate so orchestrators (Kubernetes, ECS, Docker Compose) can distinguish a
live-but-not-ready process from a dead one.

| Endpoint  | Semantics | Success | Failure |
|-----------|-----------|---------|---------|
| `/health` | **Liveness.** Returns `200` while the process is alive and the event loop is responsive. It does **not** check dependencies. | `200` | `500` only if the process itself is wedged |
| `/ready`  | **Readiness.** Returns `200` only when every critical dependency (DB, Redis, RPC) is reachable. Fails **closed** with `503` when any dependency is unavailable. | `200` | `503` |

### Readiness response contract

`/ready` returns a typed JSON body with a stable error code and a correlation
id so operators can trace a failing probe without leaking secrets:

```json
{
  "status": "unavailable",
  "code": "DEPENDENCY_UNAVAILABLE",
  "correlationId": "<uuid>",
  "checks": {
    "db": "ok",
    "redis": "unavailable",
    "rpc": "ok"
  }
}
```

Stable error codes:

- `OK` — all critical dependencies reachable.
- `DEPENDENCY_UNAVAILABLE` — at least one critical dependency is down.
- `DEPENDENCY_TIMEOUT` — a dependency check exceeded its deadline.

### Security & observability

- Probe responses and logs **never** include connection strings, credentials,
  hostnames, or internal addresses — only the dependency name and a coarse
  status (`ok` / `unavailable` / `timeout`).
- Readiness is **deny-by-default**: an unknown or unconfigured dependency is
  treated as unavailable, so a misconfigured deploy fails closed rather than
  serving traffic.
- Probe outcomes are emitted as structured logs/metrics keyed by dependency
  name and status, with the correlation id for cross-referencing.

### Orchestrator wiring

- **Liveness probe:** `GET /health`
- **Readiness probe:** `GET /ready`

Do not point a liveness probe at `/ready` (a dependency outage would restart a
healthy process) and do not point a readiness probe at `/health` (traffic would
be routed to a process that cannot serve it).

## Oracle credentials secret management

The oracle (`apps/oracle/oracle-config.ts`) loads its signing credentials and
upstream RPC endpoints through a single typed entrypoint. The invariants below
are enforced in code and covered by tests; treat them as the contract for any
change to oracle secrets.

### Invariants

- **Fail-closed on load.** If a required secret is missing, empty, or malformed,
  the oracle refuses to start (or refuses the privileged operation) rather than
  falling back to a default, a public endpoint, or an unauthenticated mode.
- **Deny-by-default.** Unknown or unconfigured credential sources are treated as
  unavailable. There is no implicit `process.env` passthrough for privileged
  surfaces.
- **No secrets in logs or responses.** Errors, metrics, and probe output carry
  only a stable error code, the credential *name*, and a correlation id — never
  the secret value, its length, a hash, or a prefix/suffix.
- **Server is the source of truth.** Balances, swaps, and admin actions are
  authorized server-side; client-supplied credentials or roles never elevate
  privilege.
- **Idempotent and replay-safe.** Credential rotation and privileged oracle
  operations are keyed by an idempotency key so concurrent or replayed requests
  cannot double-apply.

### Typed entrypoint & stable error codes

`loadOracleConfig()` returns a typed config object or throws a typed error with
one of these stable codes:

- `ORACLE_CONFIG_OK` — config loaded and validated.
- `ORACLE_SECRET_MISSING` — a required secret is absent or empty.
- `ORACLE_SECRET_MALFORMED` — a secret is present but fails format validation.
- `ORACLE_SECRET_SOURCE_UNAVAILABLE` — the configured secret backend (env,
  vault, KMS) is unreachable; the oracle fails closed.
- `ORACLE_AUTHZ_DENIED` — the caller lacks the required role for a privileged
  oracle surface.

Every error carries a `correlationId` so operators can trace a failure across
logs and metrics without exposing the underlying secret.

### Authz

Privileged oracle surfaces (credential rotation, signing-key selection, upstream
endpoint override) are deny-by-default and require an explicit role. Untrusted
clients cannot bypass policy by supplying their own credentials, headers, or
environment overrides.

### Observability

- Structured logs and metrics are keyed by credential *name*, outcome, and
  correlation id.
- Money-path metrics (signing attempts, settlement submissions) are emitted on
  every privileged operation so failures are actionable.
- No metric label, log field, or error message ever contains a secret value.

### Rollback / kill-switch

Any change that affects the oracle money path or mainnet credentials lands
behind a feature flag with a documented kill-switch. Rollback steps are recorded
in the PR description; disabling the flag restores the previous fail-closed
behavior without a redeploy of dependent services.

## Implementation summary (archive/sync)

`IMPLEMENTATION_SUMMARY.md` is the canonical, versioned record of what the
`vatix-backend` archive/sync path actually does. It must stay in lockstep with
the code and the docs it cites; when they diverge, the code is the source of
truth and the summary is corrected — never the other way around.

### Invariants

- **Server/contract is the source of truth.** Balances, swaps, and admin state
  are authoritative on the server/contract. The archive/sync summary describes
  how that state is mirrored, never how it is redefined client-side.
- **Deny-by-default authz.** Every archive/sync entrypoint is authorized; an
  unauthenticated or wrong-role caller is rejected with a stable error code.
- **Fail-closed writes.** If a dependency (DB, Redis, RPC) is unavailable, sync
  writes fail closed rather than partially applying or silently dropping data.
- **Idempotent and replay-safe.** Archive/sync operations are keyed by an
  idempotency key so concurrent or replayed requests cannot double-apply.

### Observability

- Archive/sync progress and failures are emitted as structured logs/metrics
  keyed by stage, outcome, and correlation id.
- Money-path metrics (settlement, balance reconciliation) are emitted on every
  sync cycle so drift is actionable.
- No log field, metric label, or error message ever contains a secret value.

### Rollback / kill-switch

Any archive/sync change that affects the money path or mainnet state lands
behind a feature flag with a documented kill-switch. Rollback steps are recorded
in the PR description; disabling the flag restores the previous fail-closed
behavior without a redeploy of dependent services.

### Related docs

- [`IMPLEMENTATION_SUMMARY.md`](IMPLEMENTATION_SUMMARY.md) — canonical summary.
- [`RATE_LIMIT_POLICY.md`](RATE_LIMIT_POLICY.md) — rate-limit governance for
  external entrypoints.
- [`apps/indexer/README.md`](apps/indexer/README.md) — indexer archive/sync
  overview.
- [`apps/indexer/src/INDEXER_CONFIG_VALIDATION_HARDENING.md`](apps/indexer/src/INDEXER_CONFIG_VALIDATION_HARDENING.md)
  — config validation hardening for the indexer.
- [`SECURITY.md`](SECURITY.md) — deny-by-default policy and probe safety
  invariants.

## Prisma seed markers

Seed data is applied through Prisma's seed entrypoint and is guarded by
**seed markers**: idempotent, typed records that record which seed set has
already been applied. Markers make seeding safe to re-run and safe to run
concurrently, and they fail closed when the database is unavailable.

### Marker contract

Each marker is keyed by a stable `key` (the seed set identifier) and carries a
`version` and an `appliedAt` timestamp. Re-applying a marker with the same
`key` and `version` is a no-op; a higher `version` supersedes the previous one.

```json
{
  "key": "core-reference-data",
  "version": 3,
  "appliedAt": "2024-01-01T00:00:00.000Z"
}
```

Stable error codes:

- `OK` — marker applied or already present at the requested version.
- `SEED_MARKER_CONFLICT` — a concurrent writer applied a different version.
- `DEPENDENCY_UNAVAILABLE` — the database was unreachable; the write failed
  closed and no marker was recorded.
- `SEED_MARKER_UNAUTHORIZED` — the caller is not permitted to write markers.

### Idempotency & concurrency

- Marker writes are idempotent: replaying the same seed set is a no-op.
- Concurrent seed runs are serialized on the marker key; the loser of the race
  observes `SEED_MARKER_CONFLICT` and must not re-apply data.
- Every marker write carries a correlation id so a seed run can be traced end to
  end without logging secrets.

### Security

- Writing seed markers is a privileged surface and is **deny-by-default**:
  only the seed runner (or an explicitly authorized operator role) may write
  markers. Untrusted clients cannot bypass this policy.
- Seed markers are never written on mainnet without the readiness checklist;
  the seed path is gated behind a feature flag/kill-switch so it can be
  disabled without a redeploy.
- Marker logs and metrics record only the marker `key`, `version`, and status —
  never credentials or connection strings.

## Git hooks (Husky)

The `.husky/` hooks run local quality gates (lint, format, tests) before a
commit. They are **CI-safe**: when the environment is non-interactive or
CI-like, the hooks no-op instead of failing the build or blocking an automated
commit.

### CI detection

A hook skips its checks when any of the following is true:

- `CI` is set to a truthy value (`true`, `1`, `yes`).
- `HUSKY=0` is set (explicit opt-out).
- `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `TRAVIS`, `BUILDKITE`, or
  `JENKINS_URL` is present.
- stdin/stdout is not a TTY (non-interactive shell).

When skipped, the hook exits `0` and prints a single line to stderr, e.g.
`husky: skipping pre-commit checks (CI/non-interactive)`. No secrets,
credentials, or environment values are logged — only the reason for the skip.

### Local behavior

Outside CI, the pre-commit hook preserves the existing developer experience:
staged files are linted/formatted and the relevant test suite runs. A failure
still blocks the commit locally, so contributors get fast feedback before
pushing.

### Bypassing locally

Use `HUSKY=0 git commit ...` to skip hooks for a single commit, or
`git commit --no-verify` as the standard Git escape hatch. Do not disable hooks
in CI configuration — the CI-safe detection already handles that path.

## Docker Compose

See [`docs/docker-compose.md`](docs/docker-compose.md) for local orchestration
and probe configuration.

## Security

See [`SECURITY.md`](SECURITY.md) for the deny-by-default policy, rate-limit
governance, and probe safety invariants.

## Docker Compose

See [`docs/docker-compose.md`](docs/docker-compose.md) for local orchestration
and probe configuration.

## Security

See [`SECURITY.md`](SECURITY.md) for the deny-by-default policy, rate-limit
governance, and probe safety invariants.
## Docker Compose

See [`docs/docker-compose.md`](docs/docker-compose.md) for local orchestration
and probe configuration.

## Security

See [`SECURITY.md`](SECURITY.md) for the deny-by-default policy, rate-limit
governance, and probe safety invariants.
