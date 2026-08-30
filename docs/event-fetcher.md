# Event Fetcher (Horizon/RPC pagination and rate limiting)

`apps/indexer/src/eventFetcher.ts` pulls contract events from the Stellar
RPC/Horizon `getEvents` endpoint for a given ledger window, transparently
paginating with the `pagingToken` cursor returned by the server.

## Rate limiting (429s)

Horizon/RPC endpoints return HTTP 429 under burst polling. The fetcher now
treats 429 as a distinct case from generic transient network errors:

- 429 responses are retried up to `DEFAULT_MAX_RATE_LIMIT_RETRIES` (5) times
  and do **not** consume the normal `maxRetries` transient-error budget.
- If the response includes a `Retry-After` header, that value is honored;
  otherwise an exponential backoff (`1s, 2s, 4s, ...`) is used.
- Every rate-limit event is recorded via telemetry
  (`indexer.rpc.rate_limited`, and `indexer.rpc.rate_limited_exhausted` when
  the retry budget is exhausted) tagged with a per-fetch `requestId` for
  correlation across logs.
- If retries are exhausted, the fetcher throws instead of silently dropping
  the page — callers must not advance the ledger cursor on failure (see
  `docs/architecture.md` and the storage cursor contract).

## Cursor stall detection

If Horizon returns the same `pagingToken` across `MAX_STALL_ITERATIONS` (3)
consecutive pages, the fetcher raises `CursorStallError` rather than looping
forever. This prevents a stuck cursor from silently starving the ingestion
loop of new events while still reporting "success".

## Production vs. development

`EventFetcher`'s constructor is fail-fast in `NODE_ENV=production`:

- `rpcUrl` must be an `https://` endpoint. A local/insecure endpoint throws
  `EventFetcherConfigError` immediately — there is no silent fallback to an
  unauthenticated or plaintext RPC in production.
- `contractId` must be set. Without it the fetcher would otherwise poll
  every contract on the network, which is never the intended production
  behavior.

Outside production (`NODE_ENV` unset or `test`/`development`), these checks
are relaxed so local stubs and integration tests can point at
`http://localhost` RPC mocks.

## Observability

Every `fetchByLedgerWindow` call generates a `requestId` (UUID) that is
attached to all telemetry emitted for that call
(`indexer.rpc.page_fetched`, `indexer.rpc.error`, `indexer.rpc.rate_limited`,
`indexer.rpc.cursor_stalled`, `indexer.events.fetched`), so a single burst of
429s or a stalled cursor can be traced end-to-end in logs/metrics. No
secrets (RPC auth tokens, keys) are ever included in telemetry tags or log
lines.

## Testing

Unit tests live in `apps/indexer/src/eventFetcher.test.ts` and cover:

- Pagination across multiple pages.
- Transient network error retries.
- 429 rate-limit backoff and recovery, and exhaustion after
  `DEFAULT_MAX_RATE_LIMIT_RETRIES`.
- Cursor stall detection (`CursorStallError`).
- Production fail-fast guardrails for `rpcUrl`/`contractId`.

Run via the existing workspace test script:

```
pnpm test
```
