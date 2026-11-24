# Rate Limiting Policy

This document outlines the rate limiting tiers applied to each endpoint in the Vatix Backend API. Rate limiting is enforced to protect against abuse, prevent resource exhaustion, and ensure fair access to the service.

## Overview

The API implements a tiered rate limiting system with the following global limits:

| Tier                    | Requests per Minute | Use Case                                                        | Configurable Env Vars                                |
| ----------------------- | ------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| **Global**              | 100                 | Default for all routes (except health/ready)                    | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`             |
| **Heavy Read**          | 20                  | Expensive read operations requiring multiple DB queries         | `RATE_LIMIT_HEAVY_MAX`, `RATE_LIMIT_HEAVY_WINDOW_MS` |
| **Write**               | 10                  | State mutations; strictest tier for non-admin                   | `RATE_LIMIT_WRITE_MAX`, `RATE_LIMIT_WRITE_WINDOW_MS` |
| **Admin**               | 30                  | Privileged admin operations                                     | `RATE_LIMIT_ADMIN_MAX`, `RATE_LIMIT_ADMIN_WINDOW_MS` |
| **Health/Ready Probes** | No limit            | Kubernetes readiness/liveness checks must never be rate-limited | N/A                                                  |

## Endpoint Classification

### Health & Readiness (No Rate Limit)

These endpoints are critical for Kubernetes and monitoring infrastructure. They **must not be rate-limited** or require authentication.

| Method | Path         | Tier | Reason                                                                      |
| ------ | ------------ | ---- | --------------------------------------------------------------------------- |
| `GET`  | `/v1/health` | None | Liveness probe; checks if HTTP server is alive. No dependency checks.       |
| `GET`  | `/v1/ready`  | None | Readiness probe; checks database and indexer health before routing traffic. |

### Read-Only Endpoints

#### Low Risk (Global Limit - 100 req/min)

Simple lookups with minimal computational cost.

| Method | Path               | Tier   | Reason                                   |
| ------ | ------------------ | ------ | ---------------------------------------- |
| `GET`  | `/v1/markets/:id`  | Global | Single-row lookup by ID; O(1) operation. |
| `GET`  | `/v1/openapi.json` | Global | Static file serving; minimal overhead.   |

#### Medium Risk (Heavy Read Limit - 20 req/min)

Expensive read operations involving joins, aggregations, or large result sets.

| Method | Path                            | Tier       | Reason                                                                                |
| ------ | ------------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| `GET`  | `/v1/markets`                   | Heavy Read | Table scan with optional filtering; can return up to 100 rows per request.            |
| `GET`  | `/v1/markets/:id/orderbook`     | Heavy Read | Expensive aggregation: retrieves open orders, groups by price level, sorts bids/asks. |
| `GET`  | `/v1/orders/user/:address`      | Heavy Read | Two DB queries (findMany + count); pagination support.                                |
| `GET`  | `/v1/trades/user/:address`      | Heavy Read | Two DB queries with date range filtering; returns up to 100 rows per request.         |
| `GET`  | `/v1/wallets/:wallet/positions` | Heavy Read | Joins positions with markets; optional per-market order-book query for PnL.           |

### Write Endpoints (Write Limit - 10 req/min)

State-mutating operations; strictest non-admin tier because side effects are costly and potentially conflicting.

| Method | Path         | Tier  | Reason                                                                                             |
| ------ | ------------ | ----- | -------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/orders` | Write | Creates order in database and runs matching engine logic; requires Stellar signature verification. |

### Admin Endpoints (Admin Limit - 30 req/min)

Privileged operations gated behind API key + admin role token. Requires `Authorization: Bearer <ADMIN_TOKEN>` header.

| Method  | Path                           | Tier  | Reason                                                                              |
| ------- | ------------------------------ | ----- | ----------------------------------------------------------------------------------- |
| `GET`   | `/v1/admin/markets`            | Admin | Lists all markets (including cancelled); lower limit than public /markets endpoint. |
| `PATCH` | `/v1/admin/markets/:id/status` | Admin | Mutates market status; requires elevated privileges.                                |

---

## Orders API Authorization & Validation

The orders API is a money-path surface. Every entrypoint is **deny-by-default** and enforces the following invariants:

1. **Authorization** — `POST /v1/orders` requires a valid Stellar signature over the canonical order payload. The recovered signer address MUST equal the order's `owner`/`address` field; mismatches are rejected with `403 FORBIDDEN`. Read endpoints (`GET /v1/orders/user/:address`) are public but scoped to the requested address only. No client-supplied field may override server-derived identity.
2. **Typed validation** — Request bodies and query params are validated against typed schemas before any DB or matching-engine work. Invalid input fails fast with `400 VALIDATION_ERROR` and a stable `code`.
3. **Idempotency** — `POST /v1/orders` accepts an optional `Idempotency-Key` header, scoped to the signing wallet and stored in the same transaction as the order (`order_idempotency_keys`). Replayed/concurrent requests with the same key and payload return the original `201` body (with `Idempotent-Replayed: true`) instead of creating a duplicate order; the same key with a different payload returns `409 IDEMPOTENCY_CONFLICT`. Requests without a key are treated as new requests, and are only processed after signature verification. See [docs/orders-route.md](docs/orders-route.md#idempotency).
4. **Fail-closed writes** — If a dependency (DB, Redis, or Stellar RPC) is unavailable, order writes return `503 DEPENDENCY_UNAVAILABLE` and MUST NOT partially persist or match. Reads may degrade but never fabricate balances.
5. **Correlation ids** — Every orders request is tagged with a correlation id (from `X-Request-Id` when present, otherwise generated) that is echoed in responses and logs for tracing. Logs never include secrets, signatures, or full tokens.

### Idempotency Key Format

The `Idempotency-Key` header value is validated against `IDEMPOTENCY_KEY_PATTERN` in `src/api/routes/orders.ts`. A key must be **1–128 characters** drawn only from:

- `A`–`Z` (uppercase letters)
- `a`–`z` (lowercase letters)
- `0`–`9` (digits)
- `_`, `-`, `.`, `:` (underscore, hyphen, period, colon)

Any other character, an empty value, or a value longer than 128 characters is rejected with `400 VALIDATION_ERROR`. A missing key is not an error today (the request is treated as new), but once the required-key requirement lands a missing key will be rejected as well.

| Example                              | Result   | Reason                                              |
| ------------------------------------ | -------- | --------------------------------------------------- |
| `order-7f3a9c2e-01`                  | Accepted | Uses only allowed characters and is within length.  |
| `order 7f3a9c2e/01`                  | Rejected | Contains a space and `/`, which are not allowed.    |

Reusing the same idempotency key with a different request hash returns `409 IDEMPOTENCY_CONFLICT`.

### Stable Error Codes (Orders)

| Code                     | HTTP | Meaning                                                        |
| ------------------------ | ---- | ------------------------------------------------------------- |
| `VALIDATION_ERROR`       | 400  | Malformed or out-of-range request payload/params.             |
| `UNAUTHORIZED`           | 401  | Missing or expired authentication/signature.                  |
| `FORBIDDEN`              | 403  | Signature valid but signer does not own the order.            |
| `IDEMPOTENCY_CONFLICT`   | 409  | Same idempotency key reused with a different payload.         |
| `RATE_LIMITED`           | 429  | Write tier exceeded.                                          |
| `DEPENDENCY_UNAVAILABLE` | 503  | DB/Redis/RPC outage; write failed closed.                     |

### Kill Switch

Order writes are gated behind the `ORDERS_WRITE_ENABLED` feature flag (default `true`). Setting it to `false` disables `POST /v1/orders` (returns `503 DEPENDENCY_UNAVAILABLE`) without affecting reads, providing a fast rollback 

/* … truncated 2623 chars — edit only what you need near the top … */
