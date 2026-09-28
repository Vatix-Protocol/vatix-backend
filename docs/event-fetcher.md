# EventFetcher

## Overview

The `EventFetcher` class retrieves raw Soroban contract events from a Stellar RPC node. It is the
first stage of the indexer pipeline — downstream parsers and the batch writer depend on the
events it returns.

## How it works

1. The caller provides a `LedgerWindow` (start and end ledger sequence numbers, inclusive).
2. `fetchByLedgerWindow()` pages through `server.getEvents()` results, collecting every event
   whose ledger falls within the requested window.
3. Each RPC page is retried with exponential back-off when a transient error is detected
   (network timeouts, 5xx responses). Non-transient errors propagate immediately.
4. Raw `EventResponse` objects are mapped to `RawChainEvent` — a minimal, serialisation-safe
   shape that downstream parsers consume.

## Pagination

`getEvents` accepts either a `startLedger` or a `cursor`, never both. The fetcher requests the
first page by `startLedger` and every following page by cursor only. The cursor is the
response-level `cursor` returned by the RPC, falling back to the last event's `pagingToken` (or
its `id`) on nodes that do not return one.

Invariants:

- **Termination.** Pagination stops at the first page shorter than `pageLimit`, or once a full
  page's last event lies beyond `endLedger`.
- **Window bounds.** Only events with `startLedger <= ledger <= endLedger` are returned, in RPC
  order.
- **No duplicates.** An event id is returned at most once per window, even if the RPC returns
  overlapping pages. Skipped duplicates are counted in `indexer.events.duplicate_skipped`.
- **Progress.** If a full page hands back the cursor that was just requested,
  pagination is retried up to `MAX_STALL_ITERATIONS` (3) times and then aborted with a
  `CursorStallError`, so a misbehaving RPC node cannot loop the indexer forever.
- **Fail closed.** If any page fails after retries, or the cursor stalls, the whole window
  throws. Events from earlier pages are never returned as a partial result, so the ledger
  cursor is never advanced past events that were not fetched.
- **Correlation.** Every page request of one window shares a `requestId`, attached to
  telemetry tags and to any thrown `EventFetcherError`.

## Configuration

`EventFetcher` is instantiated with an `EventFetcherConfig`. Invalid values throw an
`EventFetcherConfigError` from the constructor.

| Field            | Type                 | Required | Default | Description                                      |
| ---------------- | -------------------- | -------- | ------- | ------------------------------------------------ |
| `rpcUrl`         | `string \| string[]` | Yes      | —       | Stellar Soroban RPC endpoint URL(s), failed over |
| `contractId`     | `string`             | Yes      | —       | Contract whose events are fetched                |
| `maxRetries`     | `number`             | No       | `3`     | Maximum retry attempts for transient failures    |
| `retryDelayMs`   | `number`             | No       | `500`   | Base delay before first retry (doubles each)     |
| `pageLimit`      | `number`             | No       | `100`   | Events per RPC page request (integer, 1–10000)   |
| `fetchTimeoutMs` | `number`             | No       | `15000` | Per-page `getEvents` timeout; `0` disables it    |

## Errors

Every failure of `fetchByLedgerWindow()` is an `EventFetcherError` with a stable `code`, a
`retryable` flag, the `startLedger`, the `cursor` of the failing page (if any), the
`requestId`, and the underlying `cause`.

| Code                            | Retryable | Meaning                                                     |
| ------------------------------- | --------- | ----------------------------------------------------------- |
| `EVENT_FETCH_RETRIES_EXHAUSTED` | Yes       | A page kept failing with transient errors past `maxRetries` |
| `EVENT_FETCH_NON_RETRYABLE`     | No        | A page failed with a fatal error (e.g. non-429 4xx)         |
| `EVENT_FETCH_CURSOR_STALLED`    | Yes       | The RPC cursor stopped advancing (`CursorStallError`)       |
| `EVENT_FETCH_INVALID_WINDOW`    | No        | The window is not `1 <= startLedger <= endLedger` integers  |

## Retry strategy

`retry.ts` classifies every failure via `classifyError()` into one of three buckets instead
of a single transient/non-transient split:

| Classification | Examples                                     | Behavior                                                                                                                  |
| -------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `fatal`        | Parse errors (`*ParseError`), non-429 4xx    | Never retried, even with attempts remaining — the payload is wrong.                                                       |
| `rate_limited` | HTTP 429                                     | Retried with `Retry-After` (if present) or `retryDelayMs * rateLimitBackoffMultiplier` (default `4`) exponential backoff. |
| `transient`    | Network error codes (`ECONNRESET`, ...), 5xx | Retried with standard `retryDelayMs * 2^attempt` exponential backoff.                                                     |

`isTransientError()` is kept for backwards compatibility (`true` for `transient` or
`rate_limited`) but new callers should use `classifyError()` directly. This split exists
specifically so a parse error is never retried forever — regardless of what its `.code` or
message happens to look like — while a genuine 429/5xx from the Stellar RPC still backs off
and recovers. Classification always uses the RPC's own error, even when every failover
endpoint has been exhausted.

## Telemetry

Metrics are recorded via the injected `Telemetry` interface. Tags never include error messages
or RPC payloads.

| Metric                             | Description                                                |
| ---------------------------------- | ---------------------------------------------------------- |
| `indexer.events.fetched`           | Total events returned for a ledger window (tagged `pages`) |
| `indexer.events.duplicate_skipped` | Duplicate event ids dropped across overlapping pages       |
| `indexer.rpc.page_fetched`         | Events returned per RPC page                               |
| `indexer.rpc.retry`                | A page request is being retried (tagged `classification`)  |
| `indexer.rpc.cursor_stalled`       | A full page returned the cursor that was just requested    |
| `indexer.rpc.disconnection`        | A page request failed with a transient error               |
| `indexer.rpc.disconnected_backoff` | Extended backoff applied after repeated disconnections     |
| `indexer.rpc.error`                | Emitted when an RPC call fails terminally (tagged `code`)  |

## Related source files

- `apps/indexer/src/eventFetcher.ts` — implementation
- `apps/indexer/src/types.ts` — `EventFetcherConfig`, `RawChainEvent`, `LedgerWindow`
- `apps/indexer/src/retry.ts` — `classifyError()`, `withRetry()` and `sleep()` helpers
- `apps/indexer/src/telemetry.ts` — `Telemetry` interface and console default
