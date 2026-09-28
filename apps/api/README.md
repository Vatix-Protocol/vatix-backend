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

## Route map

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

| Method | Path                            | Auth                           | Rate-limit tier | Handler                         |
| ------ | ------------------------------- | ------------------------------ | --------------- | ------------------------------- |
| POST   | `/v1/auth/challenge`            | None (issues the nonce)        | Global          | `src/api/routes/auth.ts`        |
| POST   | `/v1/orders`                    | Stellar signature              | Write           | `src/api/routes/orders.ts`      |
| DELETE | `/v1/orders/:id`                | Stellar cancellation signature | Write           | `src/api/routes/orders.ts`      |
| POST   | `/v1/resolutions/:id/challenge` | Stellar signature              | Global          | `src/api/routes/resolutions.ts` |

### Service and admin routes

Admin routes require both `x-api-key` and an admin bearer token
([docs/admin-identity-operations.md](../../docs/admin-identity-operations.md)); they are
denied by default.

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
