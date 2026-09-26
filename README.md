# Vatix Protocol

Monorepo for the Vatix Protocol. Package focus: `vatix-backend`.

## Health vs. readiness probes

The backend exposes two distinct probe endpoints. They are intentionally
separate so orchestrators (Kubernetes, ECS, Docker Compose) can distinguish a
live-but-not-ready process from a dead one.

| Endpoint  | Semantics                                                                                                                                                       | Success | Failure                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------ |
| `/health` | **Liveness.** Returns `200` while the process is alive and the event loop is responsive. It does **not** check dependencies.                                    | `200`   | `500` only if the process itself is wedged |
| `/ready`  | **Readiness.** Returns `200` only when every critical dependency (DB, Redis, RPC) is reachable. Fails **closed** with `503` when any dependency is unavailable. | `200`   | `503`                                      |

### Readiness response contract

`/ready` returns a typed JSON body with a stable error code and a correlation
id so operators can trace a failing probe without leaking secrets:

```json
{
  "ready": false,
  "code": "DEPENDENCY_UNAVAILABLE",
  "correlationId": "<uuid>",
  "dependencies": {
    "database": { "status": "ok" },
    "redis": { "status": "error", "error": "Redis check failed" },
    "indexFreshness": { "status": "ok" }
  }
}
```

Stable error codes:

- `OK` — all critical dependencies reachable.
- `DEPENDENCY_UNAVAILABLE` — at least one critical dependency is down.
- `DEPENDENCY_TIMEOUT` — a dependency check exceeded its deadline
  (`READY_CHECK_TIMEOUT_MS`, default `2000` ms). The check fails closed; a
  hung driver can never hang the probe.

### Security & observability

- Probe responses and logs **never** include connection strings, credentials,
  hostnames, or internal addresses — only the dependency name and a coarse
  status (`ok` / `unavailable` / `timeout`). Dependency failures are reported
  as fixed reasons (e.g. `Database check failed`); the underlying error —
  with credentials redacted — is written to structured logs only, keyed by
  the correlation id.
- The correlation id comes from the `x-correlation-id` request header when
  present (otherwise the request id) and is echoed in both the response body
  and the `x-correlation-id` response header.
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

## Docker Compose

See [`docs/docker-compose.md`](docs/docker-compose.md) for local orchestration
and probe configuration.

## Documentation

- [`docs/SOFT_DELETED_MARKETS.md`](docs/SOFT_DELETED_MARKETS.md) — the
  soft-delete invariant, the `GET /markets?q=` search contract, and the
  ghost-market runbook.
- [`docs/oracle-dry-run.md`](docs/oracle-dry-run.md) — `ORACLE_DRY_RUN`,
  what dry-run does and does not touch, and its rollback.
- [`docs/metrics.md`](docs/metrics.md) — every exported metric, including the
  oracle failover metrics and their label contracts.
- [`docs/signature-helper.md`](docs/signature-helper.md) — oracle report
  signing, the domain/network envelope, and the frozen test vectors.
- [`docs/architecture.md`](docs/architecture.md) — end-to-end system layout.

## Security

See [`SECURITY.md`](SECURITY.md) for the deny-by-default policy, rate-limit
governance, and probe safety invariants.
