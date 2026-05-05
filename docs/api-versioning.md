# API Versioning

## Overview

All public API routes are versioned under the `/v1` prefix.

```
GET /v1/health
```

Non-versioned paths (e.g. `GET /health`) are **not registered** and return
`404 Not Found`. Clients must use the versioned path.

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

## Current Versions

| Version | Status | Base path | Notes                  |
| ------- | ------ | --------- | ---------------------- |
| v1      | Active | `/v1`     | Initial public version |
