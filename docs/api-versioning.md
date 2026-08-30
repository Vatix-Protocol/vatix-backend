# API Versioning

## Current Strategy

Routes are prefixed with `/v1/` to allow non-breaking additions in future versions. All public routes are already mounted under `/v1/`; legacy unprefixed aliases are kept temporarily for backwards compatibility and return `Deprecation`/`Sunset` headers (see below).

## Keeping Routes in Sync

Three sources of truth must remain synchronized for every route change:

1. **Live routes** — registered in `src/index.ts` and individual route files (e.g., `src/api/routes/admin.ts`)
2. **Canonical registry** — `src/api/routes/registry.ts` (`CANONICAL_V1_ROUTES` constant)
3. **OpenAPI spec** — `src/api/openapi.ts` (OpenAPI 3.0 document)

When adding, modifying, or removing a route:

- Add/update the route definition in its route file (e.g., `src/api/routes/orders.ts`)
- Add/update the entry in `CANONICAL_V1_ROUTES` with method, path, and notes
- Add/update the path in the OpenAPI `paths` object with schema and security requirements
- The contract test in `tests/route-registry-sync.test.ts` verifies all three are in sync

If these drift, the API surface becomes opaque to clients (missing OpenAPI docs) and operators (missing from the canonical registry), and changes can silently go undocumented.

| Method | Canonical path                            | Legacy alias                | Notes                                                     |
| ------ | ----------------------------------------- | --------------------------- | --------------------------------------------------------- |
| GET    | `/v1/health`                              | `/health`                   | Liveness and health summary                               |
| GET    | `/v1/ready`                               | `/ready`, `/readiness`      | Readiness checks                                          |
| GET    | `/v1/markets`                             | `/markets`                  | Market listing                                            |
| GET    | `/v1/markets/:id`                         | `/markets/:id`              | Market details                                            |
| GET    | `/v1/markets/:id/orderbook`               | `/markets/:id/orderbook`    | Market orderbook                                          |
| POST   | `/v1/orders`                              | `/orders`                   | Create order                                              |
| DELETE | `/v1/orders/:id`                          | `/orders/:id`               | Cancel order                                              |
| GET    | `/v1/orders/user/:address`                | `/orders/user/:address`     | Wallet order history                                      |
| GET    | `/v1/trades`                              | none                        | Paginated trade listing (Postgres, optional Redis cache)  |
| GET    | `/v1/trades/user/:address`                | `/trades/user/:address`     | Wallet trade history                                      |
| GET    | `/v1/wallets/:wallet/positions`           | `/positions/user/:address`  | Canonical wallet positions path                           |
| GET    | `/v1/wallets/:wallet/positions/:marketId` | none                        | Single-market position read                               |
| GET    | `/v1/wallets/:wallet/fills/stream`        | none                        | Server-Sent Events stream of order fills                  |
| GET    | `/v1/admin/markets`                       | `/admin/markets`            | Requires API key and admin auth                           |
| PATCH  | `/v1/admin/markets/:id/status`            | `/admin/markets/:id/status` | Requires API key and admin auth                           |
| GET    | `/v1/admin/analytics/summary`             | none                        | Requires API key and admin auth                           |
| POST   | `/v1/admin/audit/verify-chain`            | none                        | Verify audit hash chain; requires API key and admin auth  |
| GET    | `/v1/admin/audit/watermark/:marketId`     | none                        | Audit watermark; requires API key and admin auth          |
| GET    | `/v1/admin/audit/events/:marketId`        | none                        | Audit events; requires API key and admin auth             |
| POST   | `/v1/auth/challenge`                      | none                        | Issues a single-use signing nonce for Stellar wallet auth |
| POST   | `/v1/resolutions/:id/challenge`           | none                        | Challenge a proposed resolution (requires auth)           |
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

## Unsupported Versions

Versioning is path-based, not header-based: there is no `Accept-Version` or
`X-API-Version` request header negotiation. The version is the path prefix
(`/v1/...`), and only `/v1` is currently mounted.

Requesting any other version prefix (e.g. `/v2/markets`, `/v0/health`) does not
match a route and falls through to the global 404 handler, which returns a
clear, structured error rather than an empty or generic response:

```http
GET /v2/markets

404 Not Found
Content-Type: application/json

{
  "error": "Route GET /v2/markets not found",
  "requestId": "<request-id>",
  "statusCode": 404
}
```

This is covered by the `"returns 404 for unsupported API versions"` case in
`tests/integration/api-versioning.test.ts`. When a `/v2` (or later) API is
introduced, add its routes under a new `{ prefix: "/v2" }` scope in
`src/index.ts` alongside `/v1` — see [Adding a New Version](#adding-a-new-version) below.

## Adding a New Version

1. Introduce the new route alongside the old one (`/v2/markets` + `/markets` kept for a deprecation window).
2. Add a `Deprecation` response header to the old route pointing to the new path.
3. Update Redis key prefixes for any cache entries whose payload shape changes.
4. Remove the deprecated route after the agreed sunset period.
