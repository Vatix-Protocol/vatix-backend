# CORS Configuration

Cross-Origin Resource Sharing (CORS) is configured in the Vatix Backend to control which origins can make requests to the API. The configuration is driven by environment variables and supports both restrictive defaults and flexible local development setups.

## Overview

The API uses the `@fastify/cors` plugin with custom origin validation. All CORS-related policies are centralized in the [`src/api/middleware/cors.ts`](../src/api/middleware/cors.ts) module.

## Allowed Origins

Allowed origins are controlled by the `CORS_ALLOWED_ORIGINS` environment variable (comma-separated list). If not set, the API falls back to environment-specific defaults:

| Environment          | Default Origins                                   |
| -------------------- | ------------------------------------------------- |
| **Production**       | None (empty list — must be explicitly configured) |
| **Development/Test** | `http://localhost:3000`, `http://localhost:5173`  |

### Configuration Examples

#### Production Setup

For production, explicitly allow your frontend origins:

```bash
CORS_ALLOWED_ORIGINS=https://app.vatix.io,https://staging.vatix.io
```

#### Local Development

For development, the default configuration automatically allows localhost on common ports:

```bash
# No CORS_ALLOWED_ORIGINS needed — defaults to:
# - http://localhost:3000
# - http://localhost:5173
```

To add additional local origins, set the variable explicitly:

```bash
CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173,http://localhost:8080
```

## Permitted Methods and Headers

The following HTTP methods are allowed on all CORS requests:

| Method  |
| ------- |
| GET     |
| POST    |
| PUT     |
| PATCH   |
| DELETE  |
| OPTIONS |

The following request headers are allowed:

| Header          |
| --------------- |
| `Content-Type`  |
| `Authorization` |
| `X-Request-Id`  |

The following response headers are exposed to the client:

| Header         |
| -------------- |
| `X-Request-Id` |

## Credentials Support

Credentials (cookies, HTTP authentication headers) are supported:

```
credentials: true
```

This means cross-origin requests with `credentials: 'include'` or `withCredentials: true` are allowed, and response headers like `Set-Cookie` are sent to the client.

## Same-Origin Requests

Requests without an `Origin` header (same-origin requests) are always allowed, regardless of origin configuration.

## Preflight Requests

The API automatically handles CORS preflight (OPTIONS) requests:

- Preflight requests are responded to immediately with appropriate CORS headers
- Strict preflight validation is disabled (`strictPreflight: false`), allowing flexibility in non-standard setups

## Implementation Details

The CORS configuration is applied as a Fastify plugin registered in [`src/index.ts`](../src/index.ts) before any routes. This ensures all requests — including 404 responses — respect CORS policies.

### Code Reference

```typescript
// Location: src/api/middleware/cors.ts
export const corsPlugin = fp(async (fastify: FastifyInstance) => {
  const allowedOrigins = getAllowedOrigins();

  await fastify.register(cors, {
    origin: (origin, callback) => {
      // Same-origin requests are always allowed
      if (!origin) {
        callback(null, true);
        return;
      }
      // Check against allowed list
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin '${origin}' not allowed`), false);
      }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"],
    credentials: true,
    preflight: true,
    strictPreflight: false,
  });
});
```

## Troubleshooting

### CORS Error in Browser

If you see a CORS error in the browser, verify:

1. The frontend origin is in the `CORS_ALLOWED_ORIGINS` list (or using a default if applicable)
2. The request method is in the allowed methods list (GET, POST, PUT, PATCH, DELETE, OPTIONS)
3. The request headers are in the allowed headers list or are safe headers (Content-Type, etc.)
4. The API is running and reachable at the configured endpoint

### Localhost Not Working

If localhost is not working in development:

1. Check `NODE_ENV` — should be `development` or `test` for localhost defaults
2. If `CORS_ALLOWED_ORIGINS` is set, it overrides defaults — ensure localhost origins are included
3. Verify the frontend is using the correct protocol and port (e.g., `http://localhost:3000`, not `https://localhost:3000`)

## See Also

- [Rate Limiting](./rate-limiting.md) — Request throttling per IP and endpoint tier
- [Architecture](./architecture.md) — Service boundaries and request flow
