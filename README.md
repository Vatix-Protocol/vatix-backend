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
