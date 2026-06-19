# Rate Limiting

All API endpoints are protected by an in-memory, per-IP sliding-window rate
limiter. Limits are tiered by endpoint cost so that expensive routes receive
tighter controls without penalising cheap ones.

## Tiers

| Tier           | Default limit  | Env vars                                             | Applies to                        |
| -------------- | -------------- | ---------------------------------------------------- | --------------------------------- |
| **Global**     | 100 req / 60 s | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`             | Every route (baseline)            |
| **Heavy read** | 20 req / 60 s  | `RATE_LIMIT_HEAVY_MAX`, `RATE_LIMIT_HEAVY_WINDOW_MS` | Expensive read routes (see below) |
| **Write**      | 10 req / 60 s  | `RATE_LIMIT_WRITE_MAX`, `RATE_LIMIT_WRITE_WINDOW_MS` | Mutation routes (see below)       |
| **Admin**      | 30 req / 60 s  | `RATE_LIMIT_ADMIN_MAX`, `RATE_LIMIT_ADMIN_WINDOW_MS` | All admin routes (see below)      |

Each tier maintains its own counter, so exhausting the heavy-read budget does
not consume the global budget and vice versa.

## Route classification

### Heavy read endpoints

These routes perform expensive database operations on every call and are subject
to the **heavy read** tier (20 req / 60 s per IP) in addition to the global baseline:

| Route                               | Reason                                                     |
| ----------------------------------- | ---------------------------------------------------------- |
| `GET /v1/markets`                   | Full-table scan; no cursor-based pagination                |
| `GET /v1/markets/:id/orderbook`     | `findMany` on open orders for a market                     |
| `GET /v1/orders/user/:address`      | Two parallel DB queries (`findMany` + `count`)             |
| `GET /v1/trades/user/:address`      | Two DB queries (trades `findMany` + audit join)            |
| `GET /v1/wallets/:wallet/positions` | `findMany` with a `market` JOIN; optional order-book query |

### Write endpoints

Mutation routes carry the highest per-request cost (input validation, DB write,
and matching-engine integration) and are subject to the **write** tier
(10 req / 60 s per IP):

| Route             | Reason                                              |
| ----------------- | --------------------------------------------------- |
| `POST /v1/orders` | Validation + DB write + matching-engine integration |

### Admin endpoints

Admin routes are privileged operations already gated behind API-key and
admin-role checks. They are subject to the **admin** tier (30 req / 60 s per IP),
which is stricter than the global baseline:

| Route                                | Reason                                         |
| ------------------------------------ | ---------------------------------------------- |
| `GET /v1/admin/markets`              | Privileged full-table scan including cancelled |
| `PATCH /v1/admin/markets/:id/status` | Privileged write — changes live market status  |

### Standard endpoints

All other routes are covered only by the global baseline (100 req / 60 s per IP):

| Route                 | Notes                      |
| --------------------- | -------------------------- |
| `GET /v1/health`      | Lightweight liveness check |
| `GET /v1/ready`       | Readiness check            |
| `GET /v1/markets/:id` | Single-row point query     |

## Response format

Every response — including successful ones — carries quota-visibility headers
so clients can self-throttle before hitting a limit:

```
RateLimit-Limit: 20
RateLimit-Remaining: 17
RateLimit-Reset: 1745798460
```

| Header                | Value                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| `RateLimit-Limit`     | Maximum requests allowed in the current window                             |
| `RateLimit-Remaining` | Requests still available; `0` when the limit is reached                    |
| `RateLimit-Reset`     | Unix timestamp (seconds UTC) when the window resets and the counter clears |

Header names follow the [IETF RateLimit header fields draft](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers).

When a limit is exceeded the server responds with HTTP **429 Too Many Requests**.
The `Retry-After` header (seconds until reset) and all three quota headers are
present on the 429 response as well:

```json
{
  "error": "Too Many Requests",
  "code": "RATE_LIMITED",
  "statusCode": 429,
  "retryAfter": 42
}
```

## Configuration

All limits are configurable via environment variables (see `.env.example`).
Changes take effect on the next server start. The in-memory store resets on
restart; for distributed deployments consider replacing the store with a shared
Redis backend.

| Env var                      | Tier       | Default |
| ---------------------------- | ---------- | ------- |
| `RATE_LIMIT_MAX`             | Global     | `100`   |
| `RATE_LIMIT_WINDOW_MS`       | Global     | `60000` |
| `RATE_LIMIT_HEAVY_MAX`       | Heavy read | `20`    |
| `RATE_LIMIT_HEAVY_WINDOW_MS` | Heavy read | `60000` |
| `RATE_LIMIT_WRITE_MAX`       | Write      | `10`    |
| `RATE_LIMIT_WRITE_WINDOW_MS` | Write      | `60000` |
| `RATE_LIMIT_ADMIN_MAX`       | Admin      | `30`    |
| `RATE_LIMIT_ADMIN_WINDOW_MS` | Admin      | `60000` |

## Integrator notes

- Read `RateLimit-Remaining` on every response to track your remaining quota
  before a 429 occurs. Back off proactively when it approaches zero.
- When you do receive a 429, respect the `Retry-After` header (or equivalently
  wait until the `RateLimit-Reset` Unix timestamp) before retrying.
- The `X-Forwarded-For` header is used for IP detection when the server sits
  behind a proxy. Ensure your proxy sets this header correctly.
- Heavy and write limits are intentionally lower than the global limit. If your
  integration requires higher throughput on these routes, contact the platform
  team to discuss dedicated rate-limit tiers.
- Admin limits are enforced before the API-key and admin-role checks, so
  unauthenticated probes against admin routes still consume the admin quota.
