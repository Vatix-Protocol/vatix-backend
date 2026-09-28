# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Vatix-Protocol, please report it responsibly.

- **Do not** open a public GitHub issue for security vulnerabilities.
- Email the maintainers or use GitHub's private vulnerability reporting.
- Include a clear description, reproduction steps, and impact assessment.
- We aim to acknowledge reports within 72 hours.

## Scope

This policy covers all packages in the Vatix-Protocol monorepo, including `vatix-backend` (`apps/api`).

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

## Secrets

- Never commit secrets, tokens, or credentials to the repository.
- Never log secrets. Redact sensitive fields before emitting logs or metrics.

## References

- `apps/api/README.md` — admin API surface and route documentation.
- `apps/api/routes/orders.ts` — reference pattern for typed entrypoints, error codes, and correlation ids.
