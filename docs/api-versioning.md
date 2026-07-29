# API Versioning

## Current Strategy

Routes are prefixed with `/v1/` to allow non-breaking additions in future versions. All public routes are already mounted under `/v1/`; legacy unprefixed aliases are kept temporarily for backwards compatibility and return `Deprecation`/`Sunset` headers (see below).

| Method | Canonical path                            | Legacy alias                | Notes                                                     |
| ------ | ----------------------------------------- | --------------------------- | --------------------------------------------------------- |
| GET    | `/v1/health`                              | `/health`                   | Liveness and health summary                               |
| GET    | `/v1/ready`                               | `/ready`, `/readiness`      | Readiness checks                                          |
| GET    | `/v1/markets`                             | `/markets`                  | Market listing                                            |
| GET    | `/v1/markets/:id`                         | `/markets/:id`              | Market details                                            |
| GET    | `/v1/markets/:id/orderbook`               | `/markets/:id/orderbook`    | Market orderbook                                          |
| POST   | `/v1/orders`                              | `/orders`                   | Create order                                              |
| GET    | `/v1/orders/user/:address`                | `/orders/user/:address`     | Wallet order history                                      |
| GET    | `/v1/trades`                              | none                        | Paginated trade listing (Postgres, optional Redis cache)  |
| GET    | `/v1/trades/user/:address`                | `/trades/user/:address`     | Wallet trade history                                      |
| GET    | `/v1/wallets/:wallet/positions`           | `/positions/user/:address`  | Canonical wallet positions path                           |
| GET    | `/v1/wallets/:wallet/positions/:marketId` | none                        | Single-market position read                               |
| GET    | `/v1/admin/markets`                       | `/admin/markets`            | Requires API key and admin auth                           |
| PATCH  | `/v1/admin/markets/:id/status`            | `/admin/markets/:id/status` | Requires API key and admin auth                           |
| POST   | `/v1/auth/challenge`                      | none                        | Issues a single-use signing nonce for Stellar wallet auth |
| GET    | `/v1/openapi.json`                        | none                        | OpenAPI specification                                     |

Redis keys follow a namespaced pattern so a version bump can invalidate only affected entries without a full cache flush:

```
<resource>:<version>:<identifier>
```

Examples:

| Key                                               | TTL            | Description                                                                |
| ------------------------------------------------- | -------------- | -------------------------------------------------------------------------- |
| `orderbook:<marketId>:<outcome>`                  | 60 s           | Order book snapshot per market/outcome pair                                |
| `trades:v1:<page>:<limit>:<marketId>:<from>:<to>` | 15 s (default) | `GET /v1/trades` page cache; only written when `TRADES_CACHE_ENABLED=true` |

When the schema of a cached value changes (e.g. new field added to order book), increment the version segment (`orderbook:v2:<marketId>:<outcome>`) rather than performing a `FLUSHDB`.

## Adding a New Version

1. Introduce the new route alongside the old one (`/v2/markets` + `/markets` kept for a deprecation window).
2. Add a `Deprecation` response header to the old route pointing to the new path.
3. Update Redis key prefixes for any cache entries whose payload shape changes.
4. Remove the deprecated route after the agreed sunset period.
