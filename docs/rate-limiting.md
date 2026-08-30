# Rate Limiting

All API endpoints are protected by a **Redis-backed, distributed sliding-window rate
limiter** shared across all API replicas. Limits are tiered by endpoint cost so that
expensive routes receive tighter controls without penalising cheap ones.

## Implementation

- **Algorithm:** Sliding window using Redis sorted sets (ZSET)
- **Scope:** Distributed across all API replica instances (not per-process)
- **Failure mode:** Production fails closed (rejects excess traffic with 429) if Redis is unreachable; non-production falls back to in-memory
- **IP detection:** Uses Fastify's `request.ip`, which respects the `trustProxy` configuration:
  - **Production** (`NODE_ENV=production`): `trustProxy=1` — trusts only the immediate upstream proxy (e.g., load balancer); clients cannot bypass by spoofing `X-Forwarded-For`
  - **Development** (`NODE_ENV!=production`): `trustProxy=0` — ignores proxy headers; keys rate limiting off direct socket address only

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

## Proxy Trust Configuration (Security)

The rate limiter prevents spoofing attacks via `X-Forwarded-For` headers by configuring Fastify's
`trustProxy` setting based on the deployment topology:

- **Production (`NODE_ENV=production`):** `trustProxy=1` — only the immediate upstream proxy
  is trusted (typically a load balancer or reverse proxy). Any `X-Forwarded-For` header from
  untrusted sources is ignored; rate limiting keys off the direct socket address instead.
  This prevents attackers from bypassing rate limits by injecting fake IPs into the header.

- **Development/Test:** `trustProxy=0` — no proxy headers are trusted. Rate limiting always
  keys off the direct socket address (`request.socket.remoteAddress`), allowing local
  development without a reverse proxy.

### Configuring proxy hop count

Override the default `trustProxy` value (1 for production, 0 for dev) via the `TRUST_PROXY_HOPS`
environment variable. Set this if your deployment topology differs from the default
(e.g., multiple nested proxies):

```bash
TRUST_PROXY_HOPS=2  # Trust up to 2 proxy hops (client → proxy1 → proxy2 → API)
```

See [Fastify trustProxy documentation](https://fastify.io/docs/latest/#trustproxy) for
details on hop counting and configuration strategies.

## Configuration

Rate limits are configurable via environment variables (see `.env.example`).
Changes take effect on the next server start.

### Rate limit configuration

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

### Redis configuration

Rate limiting uses Redis to share state across replicas. Configure Redis connection
via standard environment variables (see `src/services/redis.ts`):

| Env var                    | Purpose                                         | Default    |
| -------------------------- | ----------------------------------------------- | ---------- |
| `REDIS_URL`                | Redis connection string (required when running) | (none)     |
| `REDIS_KEY_PREFIX`         | Prefix for all rate limit keys in Redis        | `vatix:`   |
| `REDIS_CONNECT_TIMEOUT`    | Socket connect timeout in ms                    | `5000`     |
| `REDIS_MAX_RETRIES`        | Max connection retry attempts before giving up  | `3`        |
| `REDIS_RETRY_BASE_DELAY`   | Base delay for exponential backoff in ms        | `100`      |
| `REDIS_RETRY_MAX_DELAY`    | Maximum delay between retries in ms             | `2000`     |

### Production failure behavior

In `NODE_ENV=production`:
- If Redis is unreachable, rate limiter **fails closed**: rejects all excess traffic with HTTP 429
- No silent fallback to in-memory or unlimited rates
- Ensures consistent rate limiting across all replicas even under degraded conditions

In non-production environments:
- If Redis is unreachable, falls back to in-memory rate limiting per process
- Allows local development and testing without Redis

## Integrator notes

- Read `RateLimit-Remaining` on every response to track your remaining quota
  before a 429 occurs. Back off proactively when it approaches zero.
- When you do receive a 429, respect the `Retry-After` header (or equivalently
  wait until the `RateLimit-Reset` Unix timestamp) before retrying.
- If you are behind a reverse proxy or load balancer, ensure your proxy sets
  the `X-Forwarded-For` header correctly with your real client IP. The server
  will trust this header only if the request comes through the configured trusted
  proxy hops. Requests from untrusted sources bypassing the proxy will be rate-limited
  using their direct socket address.
- Heavy and write limits are intentionally lower than the global limit. If your
  integration requires higher throughput on these routes, contact the platform
  team to discuss dedicated rate-limit tiers.
- Admin limits are enforced before the API-key and admin-role checks, so
  unauthenticated probes against admin routes still consume the admin quota.
- **Important:** Do not attempt to spoof your client IP via the `X-Forwarded-For`
  header — the server's `trustProxy` setting will reject untrusted IPs and
  rate-limit you based on your actual source address instead.
