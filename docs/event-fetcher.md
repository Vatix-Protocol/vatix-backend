# EventFetcher

## Overview

The `EventFetcher` class retrieves raw Soroban contract events from a Stellar RPC node. It is the
first stage of the indexer pipeline — downstream parsers and the batch writer depend on the
events it returns.

## How it works

1. The caller provides a `LedgerWindow` (start and end ledger sequence numbers).
2. `fetchByLedgerWindow()` pages through `server.getEvents()` results, collecting every event
   whose ledger falls within the requested window.
3. Each RPC page is retried with exponential back-off when a transient error is detected
   (network timeouts, 5xx responses). Non-transient errors propagate immediately.
4. Raw `EventResponse` objects are mapped to `RawChainEvent` — a minimal, serialisation-safe
   shape that downstream parsers consume.

## Configuration

`EventFetcher` is instantiated with an `EventFetcherConfig`:

| Field          | Type     | Required | Default | Description                                   |
| -------------- | -------- | -------- | ------- | --------------------------------------------- |
| `rpcUrl`       | `string` | Yes      | —       | Stellar Soroban RPC endpoint URL              |
| `contractId`   | `string` | Yes      | —       | Contract whose events are fetched             |
| `maxRetries`   | `number` | No       | `3`     | Maximum retry attempts for transient failures |
| `retryDelayMs` | `number` | No       | `500`   | Base delay before first retry (doubles each)  |
| `pageLimit`    | `number` | No       | `100`   | Events per RPC page request                   |

## Retry strategy

Retries use exponential back-off: `retryDelayMs * 2^attempt`. Only errors identified as
transient by `isTransientError()` (from `retry.ts`) trigger a retry; all other errors are
thrown immediately. After `maxRetries` consecutive transient failures the last error is
re-thrown.

## Telemetry

Two metrics are recorded via the injected `Telemetry` interface:

| Metric                     | Description                               |
| -------------------------- | ----------------------------------------- |
| `indexer.events.fetched`   | Total events returned for a ledger window |
| `indexer.rpc.page_fetched` | Events returned per RPC page              |
| `indexer.rpc.error`        | Emitted when an RPC call fails terminally |

## Related source files

- `apps/indexer/src/eventFetcher.ts` — implementation
- `apps/indexer/src/types.ts` — `EventFetcherConfig`, `RawChainEvent`, `LedgerWindow`
- `apps/indexer/src/retry.ts` — `isTransientError()` and `sleep()` helpers
- `apps/indexer/src/telemetry.ts` — `Telemetry` interface and console default
