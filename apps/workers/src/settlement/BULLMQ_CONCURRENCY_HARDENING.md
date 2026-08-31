# BullMQ settlement concurrency & stalled-job hardening (Issue 2)

## Problem

`apps/workers/src/settlement/bullmq-consumer.ts` hardcoded `concurrency: 1`
with no explicit `lockDuration`/`stalledInterval`/`maxStalledCount`, and no
guard preventing an operator from raising concurrency via config/env in a
way that double-applies `settle_trade` (the settlement worker's Redis
idempotency check-then-set is not atomic across concurrent in-process
handlers). BullMQ's defaults for stall detection also weren't tuned against
`PROCESSING_TIMEOUT_MS`, so a slow-but-alive job could be reclaimed and
redelivered to a second replica while the first was still finishing.

## What changed

- `resolveSettlementConcurrency()` (exported, pure) computes worker
  concurrency from `SETTLEMENT_WORKER_CONCURRENCY` and **throws at startup**
  if `NODE_ENV=production` and the resolved value isn't `1` — fail-fast
  instead of a silent double-apply.
- `lockDuration` explicitly set to `2 * PROCESSING_TIMEOUT_MS` so BullMQ
  doesn't reclaim a job that's still legitimately running.
- `stalledInterval` and `maxStalledCount: 1` set explicitly so a stalled
  job is retried at most once via the stall path before falling onto the
  normal DLQ-eligible retry path, where the idempotency key is
  authoritative.
- New `worker.on("stalled", ...)` handler emits
  `vatix_settlement_job_stalled_total` and a structured log with the job id
  (correlation id) — no payload/secret data logged.
- `settlement-worker.ts` now increments `vatix_settlement_duplicate_skipped_total`
  at the existing "already processed" idempotency short-circuit, so
  duplicate delivery is visible in metrics, not just logs.
- Added `bullmq-consumer.test.ts` covering the fail-fast production guard,
  the dev/local stub allowance, the default, and invalid-input fallback.
- Documented `SETTLEMENT_WORKER_CONCURRENCY` in `.env.example` and added
  detection/response guidance to `docs/runbooks/incident-runbook.md`
  (Incident 8).

## Why this closes the gap

The double-apply risk had two independent causes: (1) nothing stopped
concurrency from being raised above the safe value, and (2) stalled-job
recovery wasn't tuned, so BullMQ's own retry mechanism could hand the same
job to two workers. Both are now closed — one via a startup assertion, the
other via explicit lock/stall tuning plus observability into how often it
happens.
