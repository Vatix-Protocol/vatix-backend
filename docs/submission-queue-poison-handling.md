# Submission Queue Poison Handling (#1150)

Quarantine semantics for oracle submissions that can never succeed.
Implemented in [`apps/oracle/submission-queue.ts`](../apps/oracle/submission-queue.ts).

## Why

The submission queue feeds a money path: a signed resolution is enqueued, then
submitted on-chain. If a single malformed or permanently-rejected submission is
retried forever it pins the worker in a retry loop, starves every other market's
resolution, and (for the in-memory queue) grows without bound. That is both an
availability gap and a liveness risk for settlement.

## Behaviour

| Situation                                                           | Result                                                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Item enqueued for the first time                                    | `pending`, one `Oracle submission queued` log                                                                                                 |
| Same `id` enqueued again while live                                 | Idempotent: the existing item is returned, logged as `Oracle submission deduplicated` — never double-submitted                                |
| `recordFailure` below the threshold                                 | `failed`, `attempts++`, warning log with `id`/`marketId`/attempts                                                                             |
| `recordFailure` reaching `maxAttemptsBeforeQuarantine`              | Terminal `quarantined` status + `quarantinedAt`, single error-level log                                                                       |
| Any further `recordFailure` / `recordSuccess` on a quarantined item | Idempotent no-op — quarantine is terminal and can only be released explicitly                                                                 |
| Re-enqueue of a quarantined item                                    | `SubmissionQueueError` `SUBMISSION_QUEUE_POISON`, `retryable: false`, `statusCode: 422` → consumer dead-letters instead of re-arming the loop |
| Queue at `maxQueueDepth`                                            | `SubmissionQueueError` `SUBMISSION_QUEUE_FULL`, `retryable: true`, `statusCode: 503` → shed load, fail closed                                 |
| Unknown `id`                                                        | `SUBMISSION_QUEUE_NOT_FOUND` (`404`)                                                                                                          |

Stable error codes live in `SUBMISSION_QUEUE_ERROR_CODES`; every operational
error carries a `correlationId` and a `retryable` flag. Logs contain the item
`id`, `marketId`, `oracleAddress`, attempts, and timestamps only — never the
provider payload or any secret. `lastError` is truncated to 512 characters so a
hostile producer cannot bloat memory.

`SubmissionQueue.getSnapshot()` now also reports the `quarantined` count so
operators can size DLQ/replay work.

## Configuration

```bash
# Attempts before an item becomes a poison message. Default: 5.
ORACLE_SUBMISSION_POISON_MAX_ATTEMPTS=5

# Maximum retained (non-quarantined) items. Default: 10000.
ORACLE_SUBMISSION_QUEUE_MAX_DEPTH=10000
```

Both fall back to their safe default when absent, blank, non-integer, or
non-positive — a broken value can never disable the guards.

The Redis/BullMQ path (`apps/workers/src/oracle/`) keeps its own attempt
budget and DLQ; this in-memory queue is the compatibility/migration surface and
the reference for the same poison semantics.

## Tests

`apps/oracle/submission-queue-poison.test.ts` covers idempotent re-enqueue,
threshold quarantine, terminal-quarantine idempotency, poison replay rejection,
capacity fail-closed, typed error codes, snapshot counts, and error truncation.

## Runbook

1. Alert on `Oracle submission quarantined as poison message`.
2. Inspect the item (`id`, `marketId`, `attempts`, `lastError`) in the queue
   snapshot / DLQ.
3. Fix the root cause (bad payload, wrong contract/network config) _before_
   re-enqueueing — the poison guard will reject a replay until the item is
   explicitly released.

## Rollback

Thresholds are plain config: raise `ORACLE_SUBMISSION_POISON_MAX_ATTEMPTS` to
quarantine later (or effectively not at all) and restart the producer without a
schema or on-chain change.
