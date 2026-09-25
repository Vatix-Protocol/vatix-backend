# Price Fetcher

The **Price Fetcher** is an internal component of the Oracle app that is responsible for retrieving external asset pricing data.

## Overview

The component securely and reliably requests live price feeds from registered external providers and returns structured responses with confidence scores.

## Providers

- **Primary Provider**: Used for the first attempt.
- **Fallback Provider**: Kicks in automatically if the primary provider times out, fails authentication, or returns an invalid response.

## Integration

The price fetcher results are enqueued into the **Submission Queue** to be later signed and dispatched on-chain.

## Source Attribution (#994)

`fetchPrice()` returns a `PriceFetchResult`, not a bare number:

```typescript
interface PriceFetchResult {
  price: number;
  source: "primary" | "fallback";
  sourceMetadata: { provider: string; requestId: string };
  fetchedAt: string;
}
```

- `source` records which provider **tier** produced the price (`primary` or
  `fallback`) so it can be persisted onto `OracleReport.source` and used in
  forensics — without this, an operator investigating a bad resolution
  could not tell whether the underlying price came from the trusted
  primary feed or a lower-confidence fallback.
- `sourceMetadata.provider` is the specific provider name (e.g.
  `coingecko`, `pyth`) configured via `PriceProviderConfig.name`.
- `sourceMetadata.requestId` is a per-fetch correlation id (UUID) included
  in every log line for that fetch, so a single price fetch can be traced
  end-to-end across primary/fallback attempts.

## Production / Development Split

`PriceFetcher` requires an explicit `primaryProvider` in
`NODE_ENV=production` — the constructor throws
`PriceFetcherValidationError` immediately if one isn't supplied, rather
than silently using the built-in local stub price. Outside production, a
local stub provider is used automatically when `primaryProvider` is
omitted, so local dev and tests keep working without extra configuration.

If every configured provider (primary, then fallback) fails, `fetchPrice()`
throws `AllPriceProvidersFailedError` — no default or stale price is ever
returned in its place.
