# API Versioning

## Current Strategy

Routes are prefixed with `/v1/` to allow non-breaking additions in future versions.

| Route | Path | Notes |
|---|---|---|
| Health | `GET /v1/health` | Versioned — returns `version` field from package.json |
| Markets | `GET /markets` | Unversioned — will migrate to `/v1/markets` |
| Orders | `GET /orders/user/:address` | Unversioned — pending v1 prefix migration |
| Positions | `GET /wallets/:wallet/positions` | Unversioned — pending v1 prefix migration |

> **Open work**: Unversioned routes will gain the `/v1/` prefix before the first public release. See [docs/architecture.md](architecture.md) for the full service map.

| Method | Canonical path                            | Legacy alias                | Notes                           |
| ------ | ----------------------------------------- | --------------------------- | ------------------------------- |
| GET    | `/v1/health`                              | `/health`                   | Liveness and health summary     |
| GET    | `/v1/ready`                               | `/ready`, `/readiness`      | Readiness checks                |
| GET    | `/v1/markets`                             | `/markets`                  | Market listing                  |
| GET    | `/v1/markets/:id`                         | `/markets/:id`              | Market details                  |
| GET    | `/v1/markets/:id/orderbook`               | `/markets/:id/orderbook`    | Market orderbook                |
| POST   | `/v1/orders`                              | `/orders`                   | Create order                    |
| GET    | `/v1/orders/user/:address`                | `/orders/user/:address`     | Wallet order history            |
| GET    | `/v1/trades/user/:address`                | `/trades/user/:address`     | Wallet trade history            |
| GET    | `/v1/wallets/:wallet/positions`           | `/positions/user/:address`  | Canonical wallet positions path |
| GET    | `/v1/wallets/:wallet/positions/:marketId` | none                        | Single-market position read     |
| GET    | `/v1/admin/markets`                       | `/admin/markets`            | Requires API key and admin auth |
| PATCH  | `/v1/admin/markets/:id/status`            | `/admin/markets/:id/status` | Requires API key and admin auth |
| GET    | `/v1/openapi.json`                        | none                        | OpenAPI specification           |

Redis keys follow a namespaced pattern so a version bump can invalidate only affected entries without a full cache flush:

```
<resource>:<version>:<identifier>
```

Examples:

| Key | TTL | Description |
|---|---|---|
| `orderbook:<marketId>:<outcome>` | 60 s | Order book snapshot per market/outcome pair |

When the schema of a cached value changes (e.g. new field added to order book), increment the version segment (`orderbook:v2:<marketId>:<outcome>`) rather than performing a `FLUSHDB`.

## Adding a New Version

1. Introduce the new route alongside the old one (`/v2/markets` + `/markets` kept for a deprecation window).
2. Add a `Deprecation` response header to the old route pointing to the new path.
3. Update Redis key prefixes for any cache entries whose payload shape changes.
4. Remove the deprecated route after the agreed sunset period.
