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

## Response Headers

All responses include IETF-compliant rate limit headers:

```
RateLimit-Limit     — Maximum requests allowed in the current window
RateLimit-Remaining — Requests remaining in the current window
RateLimit-Reset     — Unix timestamp (seconds) when the window resets
```

When a client exceeds the rate limit, the API responds with:

```
HTTP 429 Too Many Requests
Retry-After: <seconds-until-reset>

{
  "error": "Too Many Requests",
  "code": "RATE_LIMITED",
  "statusCode": 429,
  "retryAfter": <seconds>
}
```

The `Retry-After` header indicates how long the client should wait before retrying.

---

## How to Extend or Modify Rate Limits

### Adding a New Endpoint

When adding a new endpoint to the API:

1. **Classify the endpoint** into one of the risk tiers above
2. **Apply the limiter** in the route handler:
   ```typescript
   // Example: Heavy read endpoint
   fastify.get("/new/endpoint", {
     onRequest: [heavyReadLimiter],
     // ...handler
   });
   ```
3. **Add the route to the OpenAPI spec** in `src/api/openapi.ts`
4. **Add unit tests** verifying the rate limit is enforced (see `src/api/middleware/rateLimiter.test.ts`)

### Adjusting Limits

Override default limits via environment variables:

```bash
# Global limits
RATE_LIMIT_MAX=150              # Default: 100
RATE_LIMIT_WINDOW_MS=60000      # Default: 60,000 (1 minute)

# Heavy read limits
RATE_LIMIT_HEAVY_MAX=30         # Default: 20
RATE_LIMIT_HEAVY_WINDOW_MS=60000

# Write limits
RATE_LIMIT_WRITE_MAX=15         # Default: 10
RATE_LIMIT_WRITE_WINDOW_MS=60000

# Admin limits
RATE_LIMIT_ADMIN_MAX=50         # Default: 30
RATE_LIMIT_ADMIN_WINDOW_MS=60000
```

---

## Testing

Rate limiting is tested in `src/api/middleware/rateLimiter.test.ts`. Key test scenarios:

- ✓ Request within limit is allowed (200 OK)
- ✓ Request after exceeding limit returns 429
- ✓ 429 response includes Retry-After header
- ✓ Window resets after expiration
- ✓ Separate tiers do not interfere with each other

---

## Future Enhancements

- **User-based rate limiting**: Track limits per authenticated user or API key (currently per IP)
- **Adaptive rate limiting**: Adjust limits based on server load
- **Rate limit bypass for monitoring**: Allow health check requests to pass through without counting toward limits
- **Distributed rate limiting**: For multi-instance deployments, use Redis or similar backing store
