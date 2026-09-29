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

## JWT auth (verify only)

JWT verification is **verify-only**: the API never mints, refreshes, or mutates tokens. It
validates a presented token and derives the caller identity/role from verified claims. Any
privileged surface is unreachable until a token passes verification.

### Algorithm allowlist

Verification uses a strict, explicit algorithm allowlist. `none` and any algorithm not on the
allowlist are rejected before signature checking. The algorithm is taken from the allowlist, not
from the token header, so a forged `alg` cannot downgrade verification.

### Signature & claim validation

A token is accepted only when **all** of the following hold:

- Signature verifies against the configured key material (JWKS/secret) for the allowlisted alg.
- `iss` matches the expected issuer.
- `aud` matches the expected audience.
- `exp` is in the future and `nbf` is in the past.
- `iat` is within an allowed clock-skew window (bounded skew, not unbounded).

### Fail-closed behavior

Missing, malformed, expired, or otherwise invalid tokens fail closed with `401 UNAUTHENTICATED`.
No privileged surface is reachable without a verified token. Verification failures never fall
through to an unauthenticated handler.

### Authz (deny-by-default)

Every entrypoint is authenticated and authorized before any handler logic runs. Untrusted
clients cannot bypass policy:

- All routes require a valid session/JWT; missing or expired credentials fail closed with `401 UNAUTHENTICATED`.
- Privileged surfaces (create/cancel/amend, admin actions) require the correct role/scope; wrong role fails closed with `403 FORBIDDEN`.
- New privileged surfaces default to denied until an explicit policy is added.

### Observability

Verify outcomes are logged and counted by reason (success, expired, bad signature, bad issuer,
bad audience, disallowed alg, malformed) with a correlation id. Logs and metrics never include
tokens, secrets, or PII.

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
| `UNAUTHENTICATED` | 401 | Missing/expired/invalid credentials |
| `FORBIDDEN` | 403 | Authenticated but wrong role |
| `VALIDATION_ERROR` | 400 | Malformed/invalid payload |
| `PAYLOAD_TOO_LARGE` | 413 | Request body exceeds the configured size limit |
| `IDEMPOTENCY_CONFLICT` | 409 | Replayed key with different payload |
| `DEPENDENCY_UNAVAILABLE` | 503 | RPC/DB/Redis unavailable (writes fail closed) |
| `RATE_LIMITED` | 429 | Entrypoint rate limit exceeded |

Every response carries a correlation id (echoed from `x-correlation-id` or generated) for tracing.

### Body size limits

External HTTP entrypoints (the API and the indexer HTTP server) enforce a configurable maximum
request body size. Oversized bodies are rejected fail-closed with `413 PAYLOAD_TOO_LARGE` before
any handler logic runs, so untrusted clients cannot bypass the limit by streaming or chunking.

- The limit is configurable per environment (e.g. `MAX_BODY_BYTES`); the default is conservative
  and applies to every external entrypoint unless explicitly overridden.
- The check runs before authz/rate-limit handlers so oversized requests are cheap to reject and
  cannot be used to grief downstream services.
- Rejections return the stable `PAYLOAD_TOO_LARGE` code with a correlation id; the response never
  echoes request contents.
- Body-limit rejections are counted in metrics and logged without secrets or payload contents.

### Idempotency

Order write paths require an idempotency key. Concurrent/replayed requests with the same key
return the original result; a replay with a different payload returns `IDEMPOTENCY_CONFLICT`.

### Fail-closed writes

When a dependency (RPC/DB/Redis) is unavailable, writes are rejected with
`DEPENDENCY_UNAVAILABLE` rather than partially applied. Reads may degrade, but money-path
writes never proceed on an unverified dependency.

### Observability

Metrics and logs cover the money path (order create/cancel/amend, authz denials, idempotency
hits/conflicts, dependency failures, body-limit rejections). Logs never include secrets, tokens,
or full credentials.

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
