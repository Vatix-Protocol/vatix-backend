# Error Handler

The API uses a single global error handler (`src/api/middleware/errorHandler.ts`)
registered before routes in `buildServer()`. All thrown errors — including
Fastify validation failures and custom `AppError` subclasses — are normalised into
a consistent JSON envelope.

## Error Envelope

Every error response uses the `ErrorEnvelope` shape defined in
`src/types/errors.ts`:

| Field        | Type     | Description                                                 |
| ------------ | -------- | ----------------------------------------------------------- |
| `code`       | `string` | Stable snake_case identifier (safe to switch on in clients) |
| `message`    | `string` | Human-readable description                                  |
| `error`      | `string` | Duplicate of `message` for legacy clients                   |
| `statusCode` | `number` | HTTP status (mirrors the response status line)              |
| `requestId`  | `string` | Correlates the response with server logs                    |
| `metadata`   | `object` | Optional — present for `ValidationError` field details      |
| `stack`      | `string` | Optional — included only outside production for 5xx errors  |

Example (development, 404):

```json
{
  "code": "not_found",
  "message": "Market not found",
  "error": "Market not found",
  "statusCode": 404,
  "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

## Custom Error Classes

Defined in `src/api/middleware/errors.ts`:

| Class                 | HTTP | `code`             | Notes                             |
| --------------------- | ---- | ------------------ | --------------------------------- |
| `ValidationError`     | 400  | `validation_error` | Optional `metadata.fields` object |
| `UnauthorizedError`   | 401  | `unauthorized`     |                                   |
| `ForbiddenError`      | 403  | `forbidden`        |                                   |
| `NotFoundError`       | 404  | `not_found`        |                                   |
| `MarketNotFoundError` | 404  | `market_not_found` | Includes market ID in message     |
| Generic `Error`       | 500  | `internal_error`   | Message hidden in production      |

## Environment Behaviour

Controlled by `NODE_ENV` (see `.env.example`):

| Environment   | 5xx `message` in response | `stack` in response body | Stack in server logs |
| ------------- | ------------------------- | ------------------------ | -------------------- |
| `development` | Original error message    | Included                 | Included             |
| `test`        | Original error message    | Included                 | Included             |
| `production`  | `"Internal server error"` | Omitted                  | Included             |

Client errors (4xx) always return the original message regardless of environment.

## Logging

The error handler emits structured logs via `request.log`:

- **4xx** → `warn` level with `requestId`, `method`, `path`, `statusCode`, `message`
- **5xx** → `error` level with the same fields plus `stack`

These fields align with the API request logger documented in [logger.md](./logger.md).

## Testing

- Unit tests: `src/api/middleware/errorHandler.test.ts`
- Integration helper: `tests/integration/helpers/build-test-app.ts` registers the
  real error handler on test Fastify instances.

## See Also

- [Testing Guide](./testing.md)
- [Environment Variables](./env-validation.md)
- [API Request Logger](./logger.md)
