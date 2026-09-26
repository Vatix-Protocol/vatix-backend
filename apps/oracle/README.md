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
