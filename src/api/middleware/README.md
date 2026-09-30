# Middleware

Request-handling plugins registered on the Fastify server in [src/index.ts](../../index.ts).

## Modules

| File              | Role                                                                                                                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestId.ts`    | Accepts a caller-supplied `x-request-id` UUID or generates one; echoes it in the response header. Register first so the ID is set before any log entry.                                                                                                                 |
| `logger.ts`       | Structured request/response logging. Redacts secrets before writing to stdout.                                                                                                                                                                                          |
| `cors.ts`         | CORS policy driven by `CORS_ALLOWED_ORIGINS` env var. Falls back to `localhost:3000/5173` in dev, blocks all cross-origin in production unless configured.                                                                                                              |
| `rateLimiter.ts`  | In-process sliding-window rate limiter with three tiers: global (100 req/60 s), heavy-read (20 req/60 s), write (10 req/60 s). Emits IETF RateLimit headers.                                                                                                            |
| `errorHandler.ts` | Centralised error-to-response mapping. Converts thrown errors (`ValidationError`, `NotFoundError`, unhandled exceptions) into the standard error envelope.                                                                                                              |
| `errors.ts`       | Custom error classes (`ValidationError`, `NotFoundError`) thrown by routes and services.                                                                                                                                                                                |
| `apiKeyAuth.ts`   | Static API-key guard for internal-facing endpoints.                                                                                                                                                                                                                     |
| `adminGuard.ts`   | Admin-only route guard; validates the `X-Admin-Key` header.                                                                                                                                                                                                             |
| `responses.ts`    | `success(data)` helper for the uniform 200 envelope, and `unauthorized()` / `forbidden()` / `matchingUnavailable()` / `serviceUnavailable()`, which send the **same** standard error envelope as `errorHandler` (including `requestId`) for guards that reply directly. |

## Queue Consumer Interaction

Routes that trigger background work (e.g. order creation) enqueue a job to Redis after writing to the database. The middleware layer is not involved in consuming those jobs — that is handled by the Workers module (`apps/workers/`).

```
HTTP request
   │
   ▼
rateLimiter → requestId → logger → route handler
                                        │
                              DB write + redis xadd (enqueue)
                                        │
                              response returned to client
                                        │
                                  (async, decoupled)
                                        ▼
                              Worker picks up job from Redis Stream
```

See [docs/architecture.md](../../../docs/architecture.md) for the full data-flow diagram and [apps/workers/README.md](../../../apps/workers/README.md) for the consumer side.
