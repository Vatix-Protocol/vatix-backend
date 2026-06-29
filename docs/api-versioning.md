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

## Redis Cache Key Conventions

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
