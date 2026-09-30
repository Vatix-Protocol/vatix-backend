# Middleware

Request-handling plugins registered on the Fastify server in [src/index.ts](../../index.ts).

## Modules

| File              | Role                                                                                                                                                                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestId.ts`    | Resolves the correlation id: accepts a caller-supplied `x-request-id` **only when it is a valid UUID**, otherwise generates one and exposes it as `request.id`. Echoes it in the response header and reuses the same id in the `success()` envelope, so response body, header, and structured logs all carry one id. |
| `logger.ts`       | Structured request/response logging. Redacts secrets before writing to stdout.                                                                                                                                                                                                                                       |
| `cors.ts`         | CORS policy driven by `CORS_ALLOWED_ORIGINS` env var. Falls back to `localhost:3000/5173` in dev, blocks all cross-origin in production unless configured.                                                                                                                                                           |
| `rateLimiter.ts`  | In-process sliding-window rate limiter with three tiers: global (100 req/60 s), heavy-read (20 req/60 s), write (10 req/60 s). Emits IETF RateLimit headers.                                                                                                                                                         |
| `errorHandler.ts` | Centralised error-to-response mapping. Converts `ValidationError`, `NotFoundError`, and unhandled exceptions to consistent JSON payloads.                                                                                                                                                                            |
| `errors.ts`       | Custom error classes (`ValidationError`, `NotFoundError`) thrown by routes and services.                                                                                                                                                                                                                             |
| `apiKeyAuth.ts`   | Static API-key guard for internal-facing endpoints.                                                                                                                                                                                                                                                                  |
| `adminGuard.ts`   | Admin-only route guard; validates the `X-Admin-Key` header.                                                                                                                                                                                                                                                          |
| `responses.ts`    | `success(data)` helper for uniform 200 response envelopes.                                                                                                                                                                                                                                                           |

## Correlation id

Every request gets exactly one correlation id, resolved by `requestId.ts` and
exposed as Fastify's `request.id`:

1. A caller-supplied `x-request-id` is accepted **only if it is a valid UUID**
   (`UUID_REGEX`). Anything else — a non-UUID string, a duplicate/array header,
   or an oversized/log-injection payload — is discarded and a fresh
   `crypto.randomUUID()` is generated. This is a trust boundary: the id lands
   in logs, metrics, and response bodies, so it is never taken verbatim from
   untrusted input.
2. The id is echoed back on the `x-request-id` response header.
3. The same id is used for the `requestId` field in every structured log line
   (pino `requestIdLogLabel`) and in the `requestId` of the `success()` and
   error envelopes.

The invariant — **one id per request across header, body, and logs** — is what
lets an operator go from a support ticket quoting `x-request-id` straight to the
request's log lines and the DB/Redis work behind it. It is covered by tests in
`responses.test.ts`.

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
