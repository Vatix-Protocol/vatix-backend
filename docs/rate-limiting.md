# Rate Limiting

All API endpoints are protected by an in-memory, per-IP sliding-window rate
limiter. Limits are tiered by endpoint cost so that expensive routes receive
tighter controls without penalising cheap ones.

## Tiers

| Tier | Default limit | Env vars | Applies to |
|------|--------------|----------|------------|
| **Global** | 100 req / 60 s | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | Every route (baseline) |
| **Heavy read** | 20 req / 60 s | `RATE_LIMIT_HEAVY_MAX`, `RATE_LIMIT_HEAVY_WINDOW_MS` | Expensive read routes (see below) |
| **Write** | 10 req / 60 s | `RATE_LIMIT_WRITE_MAX`, `RATE_LIMIT_WRITE_WINDOW_MS` | Mutation routes (see below) |

Each tier maintains its own counter, so exhausting the heavy-read budget does
not consume the global budget and vice versa.

## Route classification

### Heavy read endpoints

These routes perform expensive database operations on every call:

| Route | Reason |
|-------|--------|
| `GET /markets` | Full-table scan; no cursor-based pagination |
| `GET /orders/user/:address` | Two parallel DB queries (`findMany` + `count`) |
| `GET /positions/user/:address` | `findMany` with a `market` JOIN |

Limit: **20 req / 60 s** per IP.

### Write endpoints

Mutation routes carry the highest per-request cost (input validation, DB
write, and future matching-engine work):

| Route | Reason |
|-------|--------|
| `POST /orders` | Validation + DB write + matching-engine integration |

Limit: **10 req / 60 s** per IP.

### Standard endpoints

All other routes (e.g. `GET /health`, admin routes) are covered only by the
global baseline.

Limit: **100 req / 60 s** per IP.

## Response format

When a limit is exceeded the server responds with HTTP **429 Too Many Requests**:

```json
{
  "error": "Too Many Requests",
  "code": "RATE_LIMITED",
  "statusCode": 429,
  "retryAfter": 42
}
```

The `Retry-After` response header is also set to the same value (seconds until
the window resets).

## Configuration

All limits are configurable via environment variables (see `.env.example`).
Changes take effect on the next server start. The in-memory store resets on
restart; for distributed deployments consider replacing the store with a shared
Redis backend.

## Integrator notes

- Clients should respect the `Retry-After` header and back off accordingly.
- The `X-Forwarded-For` header is used for IP detection when the server sits
  behind a proxy. Ensure your proxy sets this header correctly.
- Heavy and write limits are intentionally lower than the global limit. If your
  integration requires higher throughput on these routes, contact the platform
  team to discuss dedicated rate-limit tiers.
