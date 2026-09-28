# Oracle fallback, scheduler, and price-fetcher hardening (#1109–#1112)

## Problem

Four related gaps on the oracle money path, each of which could silently
stall, corrupt, or over-reach a resolution:

1. **`PriceFetcher` never enforced its timeout (#1112).** `config.timeoutMs`
   was validated and logged, but `provider.fetchFn()` was awaited unbounded. A
   provider that never settled pinned the _sequential_ poll cycle forever, so one
   hung price feed stalled resolution for every market. The value was also never
   run through the shared timeout policy, so a misconfigured deadline was
   silently clamped outside production.

2. **The fallback chain was unbounded in time, work, and disclosure (#1109).**
   Only a _per-provider_ timeout existed, so N providers x timeout x retries
   could occupy a single resolution for minutes. The chain length was uncapped,
   so a long `ORACLE_FALLBACK_URLS` amplified outbound requests against
   third-party providers. Provider identity in error messages and Prometheus
   labels was the raw `provider.url` when no `source` was set, so a URL carrying
   userinfo or an `?api_key=` query parameter leaked a credential into logs and
   `/metrics`. A caller-supplied `signal` was ignored, so shutdown could not
   cancel in-flight provider requests.

3. **The poll loop had no reliability policy (#1110).** `main.ts` ran a fixed
   `setInterval` with a bare overlap guard: no per-cycle deadline, so a hung
   dependency pinned the loop permanently; no back-off, so a sustained DB/RPC
   outage was retried at full speed forever; no jitter, so horizontally-scaled
   replicas polled in lockstep; and cycles were chained on a timer rather than
   on completion, so a slow cycle queued a backlog of ticks. The metrics to
   see any of this did not exist.

4. **A low-confidence result was treated as a provider fault (#1111).**
   `OracleService.resolve` caught `LowConfidenceResultError` in the same
   `catch` as a provider failure and — because the error reads as retryable —
   handed it to the fallback chain. That lets a second, lower-trust opinion
   overrule a primary that already answered: precisely the "silently enqueue a
   weak signal" outcome the confidence gate exists to prevent. Two existing
   tests in `oracle-service.test.ts` were failing because of it.

Additionally, `withTimeout` reported a caller cancellation using the _timeout_
message, and `isRetryableError` treated an abort as retryable. A shutdown
therefore retried the work it had just cancelled, with back-off, and could
outlast the shutdown that triggered it.

## Fix

### `apps/oracle/price-fetcher.ts`

- `timeoutMs` is validated through `validateTimeout` (fails fast in production)
  and is now **enforced**: every attempt is raced against the deadline and gets
  an `AbortSignal` (`PriceProviderConfig.fetchFn` now optionally takes one) so a
  `fetch`-based provider releases its socket.
- `fetchPrice({ signal })` accepts a caller-owned signal; an already-aborted
  caller fails closed without dialling a provider.
- New `PriceProviderError` with a stable reason code (`TIMEOUT`, `ABORTED`,
  `INVALID_PRICE`, `PROVIDER_ERROR`) plus the per-fetch correlation `requestId`.
- Non-finite / zero / negative prices are refused (`INVALID_PRICE`) and the
  fallback gets a chance to answer.
- `AllPriceProvidersFailedError` now actually stores its `cause`; the parameter
  was previously only interpolated into the message.
- New metric `vatix_oracle_price_fetch_attempts_total{provider,outcome}`.

### `apps/oracle/fallback-adapter.ts`

- New `chainTimeoutMs` bounds the _whole_ chain; the walk stops and fails closed
  once the budget is spent. Default: per-provider timeout x
  `MAX_FALLBACK_PROVIDERS`.
- `MAX_FALLBACK_PROVIDERS` (8) caps the chain; a longer list is rejected at
  construction rather than silently truncated. `chainTimeoutMs < timeoutMs` is
  rejected as a contradiction.
- New exported `providerLabel()` — configured `source`, else a
  credential-stripped `scheme://host[:port]`, else a fixed `invalid-url`
  marker. It replaces every raw-URL usage in error messages and metric labels.
- A `200` with a non-JSON body is classified `INVALID_RESPONSE` instead of
  being retried as a transient upstream fault; a non-finite `confidence` and an
  unparseable `timestamp` are refused (the timestamp is persisted onto
  `OracleReport.createdAt`).
- The aggregate `ALL_PROVIDERS_FAILED` message is length-bounded and names the
  market and attempt count.
- `request.signal` is threaded into the attempt so cancellation aborts the
  in-flight request.

### `apps/oracle/oracle-scheduler.ts` + `main.ts`

- New `PollScheduler`: chains cycles on completion (never a fixed interval),
  skips an overlapping tick, enforces a per-cycle deadline, applies bounded
  exponential back-off after `BACKOFF_THRESHOLD` consecutive failures, and adds
  up to 20% jitter. `stop()` + `waitForIdle()` let shutdown drain the in-flight
  cycle before the queue/DB are closed.
- `getOraclePollIntervalMs` now takes the env map it is given (it previously
  read `process.env` directly, so `loadOracleConfig(env)` silently ignored the
  injected value).
- `ORACLE_CYCLE_TIMEOUT_MS` (default 300000) added to the validated config.
- New metrics: `vatix_oracle_poll_cycles_total{outcome}`,
  `vatix_oracle_poll_cycle_duration_ms`,
  `vatix_oracle_poll_consecutive_failures`.

### `apps/oracle/oracle-service.ts`, `primary-adapter.ts`, `retry-utils.ts`, `timeout-utils.ts`

- A `LowConfidenceResultError` is re-thrown immediately — never retried, never
  failed over.
- An abort is never retried and never triggers failover
  (`isAbortError` / `isRetryableError`).
- `withTimeout` accepts a caller `signal` and reports a cancellation as an
  `AbortError` with `timedOut: false`, so a deliberate cancel can never be
  mislabelled as a transient timeout.
- `PrimaryAdapter` forwards `request.signal`, matching the fallback adapter.

## Tests

- `apps/oracle/price-fetcher.test.ts` — timeout enforcement and abort
  propagation, fail-closed when every provider hangs, `TIMEOUT` vs `ABORTED`
  classification, metric emission, unusable-price rejection, production
  fail-fast on an out-of-policy timeout.
- `apps/oracle/fallback-adapter.test.ts` — chain length cap, chain deadline,
  credential hygiene in messages and metric labels, cancellation, adversarial
  provider responses.
- `apps/oracle/oracle-scheduler.test.ts` (new) — interval validation, back-off
  and jitter math, overlap skip, cycle-deadline abandonment, stop/idle, metrics.
- `apps/oracle/oracle-service.integration.test.ts` — the real service wired to
  the real adapters with only `fetchFn` and the enqueue boundary stubbed:
  primary success, timeout failover, total outage, chain short-circuiting,
  confidence gate, dry-run, cancellation, credential hygiene, and the
  production fail-closed policy.
- `apps/oracle/retry-utils.test.ts`, `apps/oracle/timeout-utils.test.ts` — an
  abort is not retryable, and is not reported as a timeout.

## Rollback / feature flag

No new feature flag: every change is strictly more fail-closed (a deadline that
was previously unenforced is now enforced; a work bound that was previously
unbounded is now bounded; a credential that could reach a log can no longer do
so). The existing `ORACLE_DRY_RUN` kill-switch remains the money-path
off-switch. `ORACLE_CYCLE_TIMEOUT_MS` and `ORACLE_POLL_INTERVAL_MS` are the two
new operational levers — raising the interval and raising the cycle deadline
restore the old, more patient cadence without a code change. Rolling back the
commit restores the previous behaviour exactly.

## Out of scope

No change to the `ProviderResult`/`ResolutionRequest` shapes beyond the optional
`fetchFn` signal, and no change to on-chain submission, signing, or settlement.
