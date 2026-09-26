# Oracle Dry-Run Mode (#1146)

Dry-run lets an operator run the **entire** oracle resolution path against real
markets and real providers while guaranteeing that nothing reaches the money
path. It answers "what would we submit?" without ever submitting.

## What dry-run does

1. Polls resolvable, non-soft-deleted markets exactly as a normal run does.
2. Calls the primary provider, then the fallback chain on a retryable primary
   failure — same timeouts, same retries, same confidence gate.
3. Logs and counts the would-be outcome.
4. **Stops.** No `OracleReport` row is written, no report is signed, and
   nothing is enqueued for on-chain submission.

## What dry-run never does

- It never writes `OracleReport` rows or submission-queue entries.
- It never signs a resolution report (`signResolutionReport` is not called).
- It never relaxes the confidence gate: a below-threshold result is still
  refused, so the fail-closed rate you observe in dry-run is the rate you
  would get with the flag off.

Dry-run is deliberately **not** a way to "test" by submitting and rolling back;
submission is irreversible on-chain, so the guard is placed before signing.

## Enabling it

```bash
ORACLE_DRY_RUN=true
```

- Parsed by `apps/oracle/oracle-config.ts` (`loadOracleConfig`). Accepts
  `true/false` and `1/0` (case-insensitive, trimmed). Any other value throws at
  startup — a typo like `ORACLE_DRY_RUN=yes` must never silently resolve to
  `false` and start submitting.
- Defaults to `false`; an unconfigured deployment always runs the real path.
- Wiring: `apps/oracle/oracle-config.ts` → `apps/oracle/main.ts` (skips
  signing/persistence/enqueue) → `apps/oracle/oracle-service.ts`
  (`dryRun` config, `isDryRun()`, never calls the submission queue or enqueue
  callback).

## Observability

| Signal                                                        | Type       | Meaning                                                                                       |
| ------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `vatix_oracle_dry_run_evaluations_total{would="submit"}`      | counter    | Resolution passed every gate and would have been enqueued.                                    |
| `vatix_oracle_dry_run_evaluations_total{would="fail_closed"}` | counter    | Resolution would have been refused (below confidence threshold).                              |
| `oracle.dry_run_enabled`                                      | log (warn) | Emitted once per poll cycle while dry-run is on — a heartbeat so a forgotten flag is visible. |
| `oracle.dry_run_would_submit`                                 | log (info) | Per market: outcome, confidence, source.                                                      |
| `oracle.dry_run_would_fail_closed`                            | log (warn) | Per market: confidence vs. threshold.                                                         |
| `oracle.dry_run_skip_submission`                              | log (info) | Poll-loop guard fired before signing.                                                         |

Logs never contain key material, provider credentials, or raw payloads.

## Rollback

Set `ORACLE_DRY_RUN=false` (or unset it) and restart the oracle process. No
migration, no data repair: dry-run writes nothing, so there is no state to
unwind. The `would` counter resets with the process like every other counter.

## Test coverage

- `apps/oracle/oracle-config.test.ts` — parsing, defaults, rejection of
  non-boolean values.
- `apps/oracle/oracle-service.test.ts` — dry-run never calls the enqueue
  callback or the submission queue; low confidence still fails closed and is
  counted as `would="fail_closed"`.
- `apps/oracle/main.test.ts` — the poll loop does not sign, persist, or enqueue
  a report in dry-run.

## Related

- `docs/oracle-submission-pipeline.md` — the full resolve → sign → submit pipeline.
- `docs/metrics.md` — metric names and label contracts.
- `apps/oracle/README.md` — fail-closed provider policy.
