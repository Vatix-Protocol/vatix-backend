# Request Body Size Limit

All API endpoints enforce a maximum request payload size to prevent large
payloads from degrading performance or enabling abuse.

## Default limit

**64 KB** (65 536 bytes) — sufficient for all current JSON payloads.

File upload endpoints are out of scope at MVP; exceptions can be handled per
route in a future iteration.

## Configuration

Override the global limit via the `BODY_LIMIT_BYTES` environment variable:

```env
BODY_LIMIT_BYTES=65536
```

The value is read once at server startup. Changes require a restart.

## Response

Requests whose body exceeds the configured limit are rejected before any route
handler runs:

- **Status**: `413 Request Entity Too Large`
- **Body**:

```json
{
  "error": "Request body is too large",
  "statusCode": 413
}
```

## Notes

- The limit applies globally to every route.
- The `bodyLimit` option is passed directly to Fastify, which enforces it at
  the HTTP layer before JSON parsing.
- Per-route overrides are possible via Fastify's route-level `bodyLimit` option
  if specific endpoints ever need a different ceiling.
