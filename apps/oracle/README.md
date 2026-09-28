# Oracle Module

## Purpose

Handles resolution-provider integrations and workflows.

## Responsibilities

- External data sourcing
- Resolution logic coordination

## Constraints

- No dependency on API internals
- Keep interfaces minimal

## Provider Failure Policy

Provider retries use the shared `src/services/providerRetry.ts` budget. The
oracle `maxRetries` setting counts retries after the initial call and defaults
to `0`.

Fallback providers are available in development and test. When
`NODE_ENV=production`, the oracle disables fallback and fails closed on any
primary provider failure, so no secondary, stale, or default off-chain value
can be signed or submitted.

A low-confidence primary result is a **definitive fail-closed gate, not a
provider fault**: it is never retried and never handed to the fallback chain.
Failing over there would let a second, lower-trust opinion overrule a primary
that already answered — exactly the "silently enqueue a weak signal" outcome
the confidence gate exists to prevent (#991/#1111).

## Fallback provider chain bounds (#1109)

`FallbackAdapter` enforces the following so a misconfiguration cannot widen the
blast radius on the money path:

- **Per-provider timeout** — `timeoutMs` (default 30s, `ORACLE_FALLBACK_TIMEOUT_MS`).
- **Whole-chain deadline** — `chainTimeoutMs` (default: per-provider timeout ×
  `MAX_FALLBACK_PROVIDERS`). The walk stops and fails closed once the budget is
  spent, so `N` providers × timeout × retries can never occupy a single
  resolution for minutes.
- **Chain length** — at most `MAX_FALLBACK_PROVIDERS` (8) entries. A longer
  `ORACLE_FALLBACK_URLS` is rejected at construction, not silently truncated.
- **No secret in telemetry** — a provider is identified in errors, logs, and
  metric labels by its configured `source`, or by a credential-stripped
  `scheme://host[:port]`. URL userinfo and query strings (which can carry an API
  key) never reach a message or a label.
- **Cancellation propagates** — a caller-supplied `signal` aborts the in-flight
  provider request, and an abort is never retried or failed over.

## Scheduler reliability (#1110)

`apps/oracle/oracle-scheduler.ts` owns the poll loop. `PollScheduler` runs a
cycle, waits, then schedules the next one — it never uses a fixed `setInterval`,
so a slow cycle cannot build a backlog of queued ticks.

| Behaviour        | Policy                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Base interval    | `ORACLE_POLL_INTERVAL_MS`, integer within `[5000, 3600000]`. Anything else throws at startup.             |
| Overlap          | A tick that lands while a cycle is running is **skipped**, never run concurrently.                        |
| Cycle deadline   | `ORACLE_CYCLE_TIMEOUT_MS` (default 300000). A cycle that overruns is abandoned and recorded as a failure. |
| Failure back-off | Exponential after 3 consecutive failures, clamped to 300000 ms. One success resets the streak.            |
| Jitter           | Up to +20% of the computed delay, so replicas that failed together do not retry in lockstep.              |
| Shutdown         | `SIGINT`/`SIGTERM` stop scheduling, then wait for the in-flight cycle (bounded by the cycle deadline).    |

Metrics: `vatix_oracle_poll_cycles_total{outcome}`,
`vatix_oracle_poll_cycle_duration_ms`, `vatix_oracle_poll_consecutive_failures`.
A rising `outcome="skipped"` share means the interval is shorter than a real
cycle — raise `ORACLE_POLL_INTERVAL_MS` or fix the slow dependency.

## Failover Metrics (#1147)

Failover is only actionable if primary and fallback traffic are separable:

| Metric                                       | Labels                                                               | Meaning                                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `vatix_oracle_provider_attempts_total`       | `provider`: `primary`/`fallback`, `outcome`: `success`/`failure`     | Outcome of each provider call made by `OracleService`. The confidence gate runs after this counter, so the series reflects provider health. |
| `vatix_oracle_fallback_chain_attempts_total` | `provider`: the chain entry (`source`, e.g. `fallback-1`), `outcome` | Outcome of each entry tried inside `FallbackAdapter`, so one flapping fallback provider is identifiable.                                    |
| `vatix_oracle_fail_closed_total`             | —                                                                    | Every provider failed (or the result was refused for low confidence): nothing was submitted.                                                |

Alert when the fallback success share rises (`provider="fallback"`), when
primary failures trend up, or when a specific chain entry in
`vatix_oracle_fallback_chain_attempts_total` stops succeeding. See
`docs/metrics.md` for PromQL examples.

## Dry-run Mode (#1146)

Set `ORACLE_DRY_RUN=true` to run the full resolution and confidence gate
without touching the money path:

```bash
ORACLE_DRY_RUN=true pnpm oracle:start
```

- The poll loop (`main.ts`) resolves markets, then stops **before** signing,
  writing an `OracleReport`, or calling `queue.enqueue`.
- `OracleService` never calls the submission queue or enqueue callback when
  `dryRun` is set; it logs and counts the would-be outcome instead
  (`vatix_oracle_dry_run_evaluations_total{would="submit"|"fail_closed"}`).
- A low-confidence result is still refused in dry-run, so the fail-closed rate
  you observe is the rate you would get with the flag off.
- Any value other than `true/false/1/0` throws at startup — a typo can never
  silently fall back to the submitting path. Default: `false`.

Full runbook: [`docs/oracle-dry-run.md`](../../docs/oracle-dry-run.md).
