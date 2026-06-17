# API Versioning

## Overview

All public API routes are versioned under the `/v1` prefix.

```
GET /v1/health
```

Non-versioned paths (e.g. `GET /health`) are supported as compatibility redirects to the canonical versioned path.
The server responds with `308 Permanent Redirect` and includes `Location`, `Deprecation`, `Sunset`, and `Link` headers until `2027-01-01T00:00:00Z`.
Deprecated path usage is logged with `{ event: "api.deprecated_path", path, clientIp }`.
After the sunset timestamp, unversioned paths return `404`.

## Public Route Table

| Method | Canonical path                  | Legacy alias                | Notes                           |
| ------ | ------------------------------- | --------------------------- | ------------------------------- |
| GET    | `/v1/health`                    | `/health`                   | Liveness and health summary     |
| GET    | `/v1/ready`                     | `/ready`, `/readiness`      | Readiness checks                |
| GET    | `/v1/markets`                   | `/markets`                  | Market listing                  |
| GET    | `/v1/markets/:id`               | `/markets/:id`              | Market details                  |
| GET    | `/v1/markets/:id/orderbook`     | `/markets/:id/orderbook`    | Market orderbook                |
| POST   | `/v1/orders`                    | `/orders`                   | Create order                    |
| GET    | `/v1/orders/user/:address`      | `/orders/user/:address`     | Wallet order history            |
| GET    | `/v1/trades/user/:address`      | `/trades/user/:address`     | Wallet trade history            |
| GET    | `/v1/wallets/:wallet/positions` | `/positions/user/:address`  | Canonical wallet positions path |
| GET    | `/v1/admin/markets`             | `/admin/markets`            | Requires API key and admin auth |
| PATCH  | `/v1/admin/markets/:id/status`  | `/admin/markets/:id/status` | Requires API key and admin auth |
| GET    | `/v1/openapi.json`              | none                        | OpenAPI specification           |

## Adding New Routes

Register all new routes inside the `v1` plugin in `src/index.ts` so they
automatically inherit the `/v1` prefix:

```ts
server.register(
  async (v1) => {
    v1.get("/your-route", handler);
  },
  { prefix: "/v1" }
);
```

## Backwards Compatibility Policy

- Routes within a version (e.g. `/v1`) are **stable**. Breaking changes
  (removed fields, changed semantics, altered response shapes) are not
  permitted without introducing a new version prefix (e.g. `/v2`).
- Additive changes (new optional fields, new endpoints) are allowed within
  the same version.
- When a new version is introduced, the previous version will be supported
  for a documented deprecation window before removal.
- Deprecation notices will be communicated via response headers
  (`Deprecation`, `Sunset`) and updated in this document.
- Root-level compatibility aliases are temporary only. New clients must use
  `/v1/*` paths and must not introduce new unversioned API URLs.

## Current Versions

| Version | Status | Base path | Notes                  |
| ------- | ------ | --------- | ---------------------- |
| v1      | Active | `/v1`     | Initial public version |
