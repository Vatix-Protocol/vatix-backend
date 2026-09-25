# Price Provider Allowlist (#1149)

Deny-by-default control over _which_ upstream price feeds the oracle is
allowed to consult. Implemented in
[`apps/oracle/price-fetcher.ts`](../apps/oracle/price-fetcher.ts).

## Why

A resolution is only as trustworthy as the feed it came from. Without an
allowlist, a mis-deployed or tampered `PriceFetcherConfig` could route money-path
prices through an arbitrary provider: a typo, an unreviewed fallback URL, or a
swapped `fetchFn` would be accepted silently. The allowlist turns that into an
explicit, testable policy decision.

## Behaviour

- Configure the allowlist either in code (`PriceFetcherConfig.allowedProviders`)
  or via the environment variable `ORACLE_PRICE_PROVIDER_ALLOWLIST`
  (comma-separated provider names, e.g. `coingecko,pyth`). An explicit config
  list wins when both are set.
- When an allowlist is in force it is enforced **twice**:
  1. at construction time — an unlisted primary or fallback provider makes the
     `PriceFetcher` fail fast, so the process never boots with a bad feed;
  2. immediately before every fetch — defense in depth against a provider
     config mutated or replaced after construction.
- Denials throw `PriceProviderNotAllowedError`
  (`code: PRICE_PROVIDER_NOT_ALLOWED`, `statusCode: 403`) and **no fetch is
  attempted**. The log line carries the provider name, tier, and the per-fetch
  correlation id — never the raw allowlist value or any secret.
- A value that is present but contains no usable entries (e.g. `",  ,"`) is a
  misconfiguration and throws `PriceProviderAllowlistInvalidError`
  (`PRICE_PROVIDER_ALLOWLIST_INVALID`) instead of silently disabling policy.
- When _no_ allowlist is configured the behaviour is unchanged (every provider
  name is accepted), but `NODE_ENV=production` logs an alertable warning telling
  the operator to set `ORACLE_PRICE_PROVIDER_ALLOWLIST`.

## Price response validation

Bogus prices are treated as provider failures, not results: a non-finite,
zero, or negative price raises `PriceProviderInvalidPriceError`
(`PRICE_PROVIDER_INVALID_PRICE`), which triggers fail-over to the fallback and,
if no provider produces a sane price, `AllPriceProvidersFailedError`. No stale
or default price is ever substituted (fail-closed).

## Configuration

```bash
# Comma-separated list of approved price-provider names (deny-by-default).
ORACLE_PRICE_PROVIDER_ALLOWLIST=coingecko,pyth
```

## Tests

`apps/oracle/price-fetcher-allowlist.test.ts` covers allow/deny at
construction and at fetch time, env-driven configuration, fail-closed parsing
of malformed allowlists, production warnings, and invalid-price handling.
`apps/oracle/price-fetcher.test.ts` covers the pre-existing source-attribution
and fail-closed behaviour.

## Rollback

Remove `ORACLE_PRICE_PROVIDER_ALLOWLIST` (or the `allowedProviders` field) and
restart the oracle. The guard is a pure in-process check with no schema, queue,
or on-chain state — there is nothing else to unwind.
