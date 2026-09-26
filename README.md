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

#### No-secret invariant for probe error messages (#1141)

A failed dependency check used to be reported by copying the driver's raw
error message into the HTTP response. That is a leak: probes are
**unauthenticated**, and driver messages routinely embed the exact values we
must never publish.

```
Can't reach database server at `postgres://vatix:s3cr3t@db.internal:5432/vatix`
connect ECONNREFUSED 10.0.0.5:6379
request to https://<token>@rpc.example/soroban failed
```

Any client that can reach the probe port could scrape those credentials and
internal hostnames. Every probe failure message is therefore now reduced by
`sanitizeProbeMessage` (`packages/shared/src/probeErrors.ts`), which redacts
DSNs, `user:password@host` URLs, bare `host:port` pairs, `api_key=…`-style
pairs, JWTs, and Stellar secret seeds, then collapses newlines and truncates to
200 characters. Benign text (`connection refused`) is preserved so on-call
engineers keep the diagnostic signal.

Each failed dependency additionally carries a stable `code` so dashboards can
alert on exact strings instead of parsing prose:

| Code                     | Meaning                                                  |
| ------------------------ | -------------------------------------------------------- |
| `DEPENDENCY_UNAVAILABLE` | The check threw or the dependency is unreachable.        |
| `PROBE_TIMEOUT`          | The check exceeded its deadline (`ETIMEDOUT`, etc.).     |
| `NO_DATA`                | Nothing has been indexed yet, so freshness is unknown.   |
| `STALE`                  | The newest indexed data is past the staleness threshold. |

The **unsanitized** message is still written to the server-side request log
alongside the correlation id, so nothing is lost for debugging — it is simply
no longer published. Response shape:

```json
{
  "ready": false,
  "dependencies": {
    "database": {
      "status": "error",
      "code": "DEPENDENCY_UNAVAILABLE",
      "error": "Can't reach database server at [REDACTED]"
    }
  }
}
```

This invariant applies to every probe surface: the API's `/v1/ready`, the
workers' `/ready`, and the indexer's `/ready`.

### Orchestrator wiring

- **Liveness probe:** `GET /health`
- **Readiness probe:** `GET /ready`

Do not point a liveness probe at `/ready` (a dependency outage would restart a
healthy process) and do not point a readiness probe at `/health` (traffic would
be routed to a process that cannot serve it).

## Docker Compose

See [`docs/docker-compose.md`](docs/docker-compose.md) for local orchestration
and probe configuration.

## Security

See [`SECURITY.md`](SECURITY.md) for the deny-by-default policy, rate-limit
governance, and probe safety invariants.
