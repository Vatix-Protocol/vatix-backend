# API Module

## Purpose

Houses all HTTP-facing logic (controllers, routes, middleware).

The public HTTP API is the Fastify server built by `buildServer()` in `src/index.ts`
(`pnpm dev` / `pnpm start`); its route plugins live in `src/api/routes/` and its middleware in
`src/api/middleware/`. This README is the map of that surface.

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

## OpenAPI / route inventory

This is the authoritative inventory of the `vatix-backend` HTTP surface under `apps/api`.
It is the source of truth for method, path, authz requirement, request/response shape, and
stable error codes. Any new route MUST be added here in the same PR that introduces it.

Authz is **deny-by-default**: every entrypoint is authenticated and authorized before any
handler logic runs. New privileged surfaces are denied until an explicit policy is added.
See [`SECURITY.md`](../../SECURITY.md) for the security model and threat assumptions.

### Stable error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Missing/expired credentials |
| `FORBIDDEN` | 403 | Authenticated but wrong role |
| `VALIDATION_ERROR` | 400 | Malformed/invalid payload |
| `IDEMPOTENCY_CONFLICT` | 409 | Replayed key with different payload |
| `DEPENDENCY_UNAVAILABLE` | 503 | RPC/DB/Redis unavailable (writes fail closed) |
| `RATE_LIMITED` | 429 | Entrypoint rate limit exceeded |

Every response carries a correlation id (echoed from `x-correlation-id` or generated) for tracing.

### Route table

| Method | Path | Authz | Request | Response | Errors |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/health` | public | — | `{ status, version }` | `DEPENDENCY_UNAVAILABLE` |
| `GET` | `/orders` | session (any role) | query: `status?`, `cursor?`, `limit?` | `{ orders: Order[], nextCursor? }` | `UNAUTHENTICATED`, `VALIDATION_ERROR`, `RATE_LIMITED` |
| `GET` | `/orders/:id` | session (owner or admin) | path: `id` | `Order` | `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR` |
| `POST` | `/orders` | session + `trader` role | body: `OrderDraft`, header: `Idempotency-Key` | `Order` | `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `DEPENDENCY_UNAVAILABLE`, `RATE_LIMITED` |
| `POST` | `/orders/:id/cancel` | session + `trader` role (owner or admin) | path: `id`, header: `Idempotency-Key` | `Order` | `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `DEPENDENCY_UNAVAILABLE` |
| `POST` | `/orders/:id/amend` | session + `trader` role (owner or admin) | path: `id`, body: `OrderAmend`, header: `Idempotency-Key` | `Order` | `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `DEPENDENCY_UNAVAILABLE` |
| `GET` | `/admin/orders` | session + `admin` role | query: `cursor?`, `limit?` | `{ orders: Order[], nextCursor? }` | `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED` |

Money-path endpoints (`POST /orders`, `POST /orders/:id/cancel`, `POST /orders/:id/amend`) are
fail-closed: when a dependency (RPC/DB/Redis) is unavailable they reject with
`DEPENDENCY_UNAVAILABLE` rather than partially applying. Reads may degrade.

## Orders API (`apps/api/routes/orders.ts`)

### Authz (deny-by-default)

Every entrypoint is authenticated and authorized before any handler logic runs. Untrusted
clients cannot bypass policy:

- All routes require a valid session/JWT; missing or expired credentials fail closed with `401 UNAUTHENTICATED`.
- Privileged surfaces (create/cancel/amend, admin actions) require the correct role/scope; wrong role fails closed with `403 FORBIDDEN`.
- New privileged surfaces default to denied until an explicit policy is added.

### Observability

### Authz (deny-by-default)

Every entrypoint is authenticated and authorized before any handler logic runs. Untrusted
clients cannot bypass policy:

- All routes require a valid session/JWT; missing or expired credentials fail closed with `401 UNAUTHENTICATED`.
- Privileged surfaces (create/cancel/amend, admin actions) require the correct role/scope; wrong role fails closed with `403 FORBIDDEN`.
- New privileged surfaces default to denied until an explicit policy is added.

### Observability

Requests and responses are typed and validated at the boundary. Stable error codes are listed
in the [route inventory](#stable-error-codes) above.

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

## Route map

## Orders API (`apps/api/routes/orders.ts`)

Rate-limit tiers and their limits are defined in [RATE_LIMIT_POLICY.md](../../RATE_LIMIT_POLICY.md).
Every route except the probes below is also subject to the global tier, and every non-admin
route except order cancellation passes admission control (load shedding,
[docs/ADMISSION_CONTROL_RUNBOOK.md](../../docs/ADMISSION_CONTROL_RUNBOOK.md)). The OpenAPI document is served at
`GET /v1/openapi.json` and rendered at `GET /docs`.

### Public reads

| Method | Path                                      | Auth | Rate-limit tier | Handler                                        |
| ------ | ----------------------------------------- | ---- | --------------- | ---------------------------------------------- |
| GET    | `/v1/markets`                             | None | Heavy read      | `src/api/routes/markets.ts`                    |
| GET    | `/v1/markets/:id`                         | None | Global          | `src/api/routes/markets.ts`                    |
| GET    | `/v1/markets/:id/orderbook`               | None | Heavy read      | `src/api/routes/markets.ts`                    |
| GET    | `/v1/orders/user/:address`                | None | Heavy read      | `src/api/routes/orders.ts`                     |
| GET    | `/v1/trades`                              | None | Heavy read      | `src/api/routes/orders.ts`                     |
| GET    | `/v1/trades/user/:address`                | None | Heavy read      | `src/api/routes/orders.ts`                     |
| GET    | `/v1/wallets/:wallet/positions`           | None | Heavy read      | `src/api/routes/positions.ts`                  |
| GET    | `/v1/wallets/:wallet/positions/:marketId` | None | Heavy read      | `src/api/routes/positions.ts`                  |
| GET    | `/v1/wallets/:wallet/fills/stream`        | None | Heavy read      | `src/api/routes/fills.ts` (Server-Sent Events) |
| GET    | `/v1/openapi.json`                        | None | Global          | `src/index.ts`                                 |
| GET    | `/docs`                                   | None | Global          | `src/index.ts` (Swagger UI)                    |

### Wallet-signed writes

Order and resolution writes carry a Stellar Ed25519 signature over the canonical payload
(`x-signature`, `x-timestamp`, `x-nonce` headers). The nonce comes from
`POST /v1/auth/challenge` and is single-use. The signer must be the `userAddress` in the body.
See [docs/orders-route.md](../../docs/orders-route.md) for the signing format.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Missing/expired/invalid credentials |
| `FORBIDDEN` | 403 | Authenticated but wrong role |
| `VALIDATION_ERROR` | 400 | Malformed/invalid payload |
| `PAYLOAD_TOO_LARGE` | 413 | Request body exceeds the configured size limit |
| `IDEMPOTENCY_CONFLICT` | 409 | Replayed key with different payload |
| `DEPENDENCY_UNAVAILABLE` | 503 | RPC/DB/Redis unavailable (writes fail closed) |
| `RATE_LIMITED` | 429 | Entrypoint rate limit exceeded |

### Service and admin routes

Admin routes require both `x-api-key` and an admin bearer token
([docs/admin-identity-operations.md](../../docs/admin-identity-operations.md)); they are
denied by default.

### Body size limits

External HTTP entrypoints (the API and the indexer HTTP server) enforce a configurable maximum
request body size. Oversized bodies are rejected fail-closed with `413 PAYLOAD_TOO_LARGE` before
any handler logic runs, so untrusted clients cannot bypass the limit by streaming

### Service and admin routes

Admin routes require both `x-api-key` and an admin bearer token
([docs/admin-identity-operations.md](../../docs/admin-identity-operations.md)); they are
denied by default.

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

| Method | Path                                            | Auth            | Rate-limit tier | Handler                                |
| ------ | ----------------------------------------------- | --------------- | --------------- | -------------------------------------- |
| GET    | `/v1/admin/markets`                             | API key + admin | Admin           | `src/api/routes/admin.ts`              |
| PATCH  | `/v1/admin/markets/:id/status`                  | API key + admin | Admin           | `src/api/routes/admin.ts`              |
| GET    | `/v1/admin/analytics/summary`                   | API key + admin | Admin           | `src/api/routes/admin.ts`              |
| POST   | `/v1/admin/markets/:id/break-glass/halt`        | API key + admin | Admin           | `src/api/routes/admin.ts`              |
| POST   | `/v1/admin/markets/:id/break-glass/cancel-all`  | API key + admin | Admin           | `src/api/routes/admin.ts`              |
| POST   | `/v1/admin/markets/:id/break-glass/resume`      | API key + admin | Admin           | `src/api/routes/admin.ts`              |
| GET    | `/v1/admin/markets/:id/break-glass/audit`       | API key + admin | Admin           | `src/api/routes/admin.ts`              |
| GET    | `/v1/admin/outbox/quarantined`                  | API key + admin | Admin           | `src/api/routes/admin.ts`              |
| POST   | `/v1/admin/outbox/quarantined/:tradeId/retry`   | API key + admin | Admin           | `src/api/routes/admin.ts`              |
| POST   | `/v1/admin/outbox/quarantined/:tradeId/discard` | API key + admin | Admin           | `src/api/routes/admin.ts`              |
| POST   | `/v1/admin/audit/verify-chain`                  | API key + admin | Admin           | `src/api/routes/audit-verification.ts` |
| GET    | `/v1/admin/audit/watermark/:marketId`           | API key + admin | Admin           | `src/api/routes/audit-verification.ts` |
| GET    | `/v1/admin/audit/events/:marketId`              | API key + admin | Admin           | `src/api/routes/audit-verification.ts` |
| GET    | `/v1/wallet/accounts/:accountId`                | API key         | Global          | `src/api/routes/wallet.ts`             |
| POST   | `/v1/wallet/accounts/:accountId/invalidate`     | API key         | Global          | `src/api/routes/wallet.ts`             |

### Probes and metrics

These routes are exempt from rate limiting and admission control.

| Method | Path         | Auth                                                                        | Handler                     |
| ------ | ------------ | --------------------------------------------------------------------------- | --------------------------- |
| GET    | `/v1/health` | None (liveness, no dependency checks)                                       | `src/api/routes/health.ts`  |
| GET    | `/v1/ready`  | None (readiness: Postgres and indexer freshness; Redis reported)            | `src/api/routes/ready.ts`   |
| GET    | `/metrics`   | Scrape token and/or IP allowlist ([docs/metrics.md](../../docs/metrics.md)) | `src/api/routes/metrics.ts` |

### Deprecated aliases

`src/api/routes/legacy.ts` registers unversioned aliases (`/health`, `/ready`, `/readiness`,
`/markets…`, `/orders…`, `/trades/user/:address`, `/positions/user/:address`,
`/admin/markets…`). Until their sunset (`2026-09-27T00:00:00Z`) they redirect to the `/v1`
route with `Deprecation`/`Sunset` headers; after it they return `404`. See
[docs/api-versioning.md](../../docs/api-versioning.md).

Outside production, `buildServer()` also registers `/test/*` error-handler routes; they are never
registered in production.

Metrics and logs cover the money path (order create/cancel/amend, authz denials, idempotency
hits/conflicts, dependency failures, body-limit rejections). Logs never include secrets, tokens,
or full credentials.

`src/api/routes/legacy.ts` registers unversioned aliases (`/health`, `/ready`, `/readiness`,
`/markets…`, `/orders…`, `/trades/user/:address`, `/positions/user/:address`,
`/admin/markets…`). Until their sunset (`2026-09-27T00:00:00Z`) they redirect to the `/v1`
route with `Deprecation`/`Sunset` headers; after it they return `404`. See
[docs/api-versioning.md](../../docs/api-versioning.md).

Outside production, `buildServer()` also registers `/test/*` error-handler routes; they are never
registered when `NODE_ENV=production`.

## Errors and tracing

Errors use one envelope, `{ code, message, error, statusCode, requestId }`
([docs/error-handler.md](../../docs/error-handler.md)). Common codes:

| Code                                                    | HTTP | Meaning                                                                        |
| ------------------------------------------------------- | ---- | ------------------------------------------------------------------------------ |
| `VALIDATION_ERROR`                                      | 400  | Malformed or out-of-range payload/params                                       |
| `UNAUTHORIZED`                                          | 401  | Missing/invalid signature, nonce, API key or admin token                       |
| `FORBIDDEN`                                             | 403  | Authenticated but not allowed                                                  |
| `NOT_FOUND`                                             | 404  | Unknown resource or route                                                      |
| `order_conflict`, `market_not_active`, `market_expired` | 409  | Order rejected against current market state (see OpenAPI)                      |
| `RATE_LIMITED`                                          | 429  | Rate-limit tier exceeded; honor `Retry-After`                                  |
| `SERVICE_UNAVAILABLE`, `MATCHING_UNAVAILABLE`           | 503  | Dependency down, matching disabled, or this replica is not the matching leader |

Every response echoes `x-request-id` (taken from a valid incoming header or generated), and the
same id is bound to every log line for the request. Logs never include secrets, signatures or
full tokens.

## Adding a route

1. Add the handler to the matching plugin in `src/api/routes/` (or a new plugin registered in the
   `/v1` scope of `buildServer()`); do not hard-code the `/v1` prefix inside the scope.
2. Pick a rate-limit tier from [RATE_LIMIT_POLICY.md](../../RATE_LIMIT_POLICY.md) and add auth
   for anything privileged: new privileged surfaces are denied by default
   ([SECURITY.md](../../SECURITY.md)).
3. Add it to `CANONICAL_V1_ROUTES` in `src/api/routes/registry.ts`, the OpenAPI spec in
   `src/api/openapi.ts`, and the route map above.

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
