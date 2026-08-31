# Fix: Timeout utils shared with fallback adapter (#992)

## Problem

`apps/oracle/timeout-utils.ts` silently **clamped** out-of-range timeout
values (below `MIN_TIMEOUT_MS` / above `MAX_TIMEOUT_MS`) to the nearest
bound and only logged a `console.warn`. `apps/oracle/fallback-adapter.ts`
defaulted to the generic `DEFAULT_TIMEOUT_MS` export rather than a value
tied to the documented fallback timeout policy in `docs/architecture.md`.
In production, a misconfigured timeout (e.g. an env var typo, or a value
in milliseconds where seconds were expected) would silently run with a
different effective timeout than what operators believe is configured —
exactly the kind of silent divergence that can drop or mis-time trade
resolutions on Stellar.

## Fix

- `validateTimeout()` now fails fast (`TimeoutValidationError`) on an
  out-of-range value when `NODE_ENV=production`, instead of clamping.
  Outside production it keeps the previous clamp-with-warning behavior so
  local dev/test stubs keep working without extra ceremony.
- Added named policy constants `PRIMARY_PROVIDER_TIMEOUT_POLICY_MS` and
  `FALLBACK_PROVIDER_TIMEOUT_POLICY_MS` (both 30s, matching
  `docs/architecture.md`) so adapters reference the documented policy
  directly rather than a generic default that could drift from it.
- `FallbackAdapter` now defaults to `FALLBACK_PROVIDER_TIMEOUT_POLICY_MS`,
  and validates both its constructor-provided `timeoutMs` and any
  per-request `timeoutMs` override through `validateTimeout()` — so a bad
  fallback timeout throws immediately in production rather than being
  silently coerced.

## Tests

- `apps/oracle/timeout-utils.test.ts`: production fail-fast on
  below-minimum and above-maximum values; clamping still works outside
  production; policy constants match documented values.
- `apps/oracle/fallback-adapter.test.ts`: constructor and per-request
  timeout overrides fail fast in production; clamp instead of throw
  outside production.

## Docs

`docs/architecture.md`'s "Oracle failover policy" section now documents
the fail-fast-in-production timeout behavior and the confidence-threshold
gate from #991.

## Out of scope

No change to retry/backoff logic or the shape of `ProviderResult`.
