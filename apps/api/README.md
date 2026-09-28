# API Module

## Purpose

Houses all HTTP-facing logic (controllers, routes, middleware).

## Scope

- Request/response handling
- Input validation
- Routing layer only

## Ownership

Backend/API team

## Notes

No business logic should live here; delegate to services.

## Orders API (`apps/api/routes/orders.ts`)

### Authz (deny-by-default)

Every orders entrypoint is authenticated and authorized before any handler logic runs.
Untrusted clients cannot bypass policy:

- All routes require a valid session/JWT; missing or expired credentials fail closed with `401 UNAUTHENTICATED`.
- Privileged surfaces (create/cancel/amend, admin actions) require the correct role; wrong role fails closed with `403 FORBIDDEN`.
- New privileged surfaces default to denied until an explicit policy is added.

### Validation & error codes

Requests and responses are typed and validated at the boundary. Stable error codes:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Missing/expired credentials |
| `FORBIDDEN` | 403 | Authenticated but wrong role |
| `VALIDATION_ERROR` | 400 | Malformed/invalid payload |
| `IDEMPOTENCY_CONFLICT` | 409 | Replayed key with different payload |
| `DEPENDENCY_UNAVAILABLE` | 503 | RPC/DB/Redis unavailable (writes fail closed) |
| `RATE_LIMITED` | 429 | Entrypoint rate limit exceeded |

Every response carries a correlation id (echoed from `x-correlation-id` or generated) for tracing.

### Idempotency

Order write paths require an idempotency key. Concurrent/replayed requests with the same key
return the original result; a replay with a different payload returns `IDEMPOTENCY_CONFLICT`.

### Fail-closed writes

When a dependency (RPC/DB/Redis) is unavailable, writes are rejected with
`DEPENDENCY_UNAVAILABLE` rather than partially applied. Reads may degrade, but money-path
writes never proceed on an unverified dependency.

### Observability

Metrics and logs cover the money path (order create/cancel/amend, authz denials, idempotency
hits/conflicts, dependency failures). Logs never include secrets, tokens, or full credentials.

### Rollback / kill-switch

Money-path or mainnet-affecting changes land behind a feature flag with a documented kill-switch
and rollback steps in the PR description.

### Testnet vs mainnet

Addresses and network config are resolved per environment; testnet/mainnet drift is guarded and
never hard-coded in the orders path.

## Admin API routes matrix

This matrix is the source of truth for admin surfaces. Every admin entrypoint is authenticated
and authorized before any handler logic runs, and is **deny-by-default**: a route with no explicit
policy entry is rejected with `403 FORBIDDEN`.

| Route | Method | Required role/scope | Idempotency | Fail-closed behavior |
| --- | --- | --- | --- | --- |
| `/admin/orders` | `GET` | `admin:orders:read` | n/a (read) | Reads may degrade; no writes applied |
| `/admin/orders/:id/cancel` | `POST` | `admin:orders:write` | Required (`Idempotency-Key`) | `DEPENDENCY_UNAVAILABLE` on RPC/DB/Redis outage; no partial cancel |
| `/admin/orders/:id/amend` | `POST` | `admin:orders:write` | Required (`Idempotency-Key`) | `DEPENDENCY_UNAVAILABLE` on RPC/DB/Redis outage; no partial amend |
| `/admin/settlement/reconcile` | `POST` | `admin:settlement:write` | Required (`Idempotency-Key`) | `DEPENDENCY_UNAVAILABLE` on RPC/DB/Redis outage; no partial reconcile |
| `/admin/liquidity/params` | `PUT` | `admin:liquidity:write` | Required (`Idempotency-Key`) | `DEPENDENCY_UNAVAILABLE` on RPC/DB/Redis outage; no partial param update |
| `/admin/feature-flags` | `PUT` | `admin:flags:write` | Required (`Idempotency-Key`) | `DEPENDENCY_UNAVAILABLE` on DB/Redis outage; no partial flag flip |

### Admin authz (deny-by-default)

- All admin routes require a valid session/JWT; missing or expired credentials fail closed with
  `401 UNAUTHENTICATED`.
- The caller must hold the exact role/scope listed above; wrong role fails closed with
  `403 FORBIDDEN`.
- Any admin route not present in the matrix above is denied by default until an explicit policy
  entry is added.

### Admin idempotency

Every admin write route requires an `Idempotency-Key`. Concurrent/replayed requests with the same
key return the original result; a replay with a different payload returns `IDEMPOTENCY_CONFLICT`.

### Admin fail-closed writes

When a dependency (RPC/DB/Redis) is unavailable, admin writes are rejected with
`DEPENDENCY_UNAVAILABLE` rather than partially applied. Admin reads may degrade, but admin
money-path writes never proceed on an unverified dependency.

### Admin observability

Metrics and logs cover admin money paths (cancel/amend, settlement reconcile, liquidity params,
feature flags), authz denials, idempotency hits/conflicts, and dependency failures. Logs never
include secrets, tokens, or full credentials.

### Admin rollback / kill-switch

Admin money-path or mainnet-affecting changes land behind a feature flag with a documented
kill-switch and rollback steps in the PR description.

### Admin testnet vs mainnet

Addresses and network config are resolved per environment; testnet/mainnet drift is guarded and
never hard-coded in the admin path.
