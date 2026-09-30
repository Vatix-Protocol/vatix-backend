# Dead Letter Log

This document describes the dead letter logging mechanism used by the workers queue consumers.

## Overview

When a job fails permanently (after all retry attempts are exhausted), the queue consumer records the failed message via the dead letter log rather than silently discarding it. This ensures every terminal failure is captured for debugging and operational visibility.

## How It Works

The dead letter log lives in `apps/workers/src/consumers/dead-letter.ts` and exposes two items:

### `DeadLetterMessage` (interface)

| Field     | Type      | Description                                     |
| --------- | --------- | ----------------------------------------------- |
| `id`      | `string`  | Unique identifier of the failed message         |
| `queue`   | `string`  | Name of the queue the message originated from   |
| `payload` | `unknown` | Original job payload (opaque to the logger)     |
| `reason`  | `string`  | Human-readable reason the job was dead-lettered |

### `logDeadLetter(logger, message)` (function)

Accepts a structured logger instance and a `DeadLetterMessage`, then writes an `error`-level log entry with structured fields:

```typescript
import { logDeadLetter, type DeadLetterMessage } from "./dead-letter.js";

const message: DeadLetterMessage = {
  id: "msg-123",
  queue: "settlement",
  payload: { tradeId: "t-456" },
  reason: "Max retries exceeded",
};

await logDeadLetter(logger, message);
// => logger.error("Job dead-lettered", { messageId, queue, reason, payloadType, payloadHash, duplicate, timestamp })
// => { duplicate: false }
```

**Log fields emitted:**

| Field         | Source                                       | Description                                                           |
| ------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| `messageId`   | `message.id`                                 | Correlates with upstream job ID                                       |
| `queue`       | `message.queue`                              | Which queue the message came from                                     |
| `reason`      | `message.reason`                             | Why the message was dead-lettered                                     |
| `payloadType` | `typeof message.payload`                     | JS type of the payload (e.g. `"object"`)                              |
| `payloadHash` | SHA-256 of `JSON.stringify(message.payload)` | Stable content hash used for dedupe                                   |
| `duplicate`   | dedupe check result                          | `true` if this exact payload+queue was already dead-lettered recently |
| `timestamp`   | `new Date().toISOString()`                   | When the dead letter was recorded                                     |

> **Note:** The `payload` value is intentionally **not** logged to avoid leaking sensitive data. `payloadType` gives operators enough context to distinguish missing payloads from structured ones. If you need payload details, inspect the dead letter store or enable `debug`-level logging upstream.

## Dedupe via Payload Hash

Every dead-lettered message is hashed (`sha256(JSON.stringify(payload))`) before it's persisted. `logDeadLetter` uses that hash to mark a Redis key (`{prefix}dead-letter:dedupe:{queue}:{payloadHash}`) with a 24-hour TTL:

- The mark is a single atomic `SET key 1 EX <ttl> NX`. It returns `null` exactly when a concurrent writer got there first, which is the **duplicate** case — the same payload was already dead-lettered for that queue within the last 24 hours (e.g. a retried burst of the same failure).
- `NX` also refreshes the TTL on a first sighting, so the key expires 24h after the _last_ occurrence.
- Both the Redis stream entry and the structured log record `payloadHash` and `duplicate`, so replays can filter out or collapse duplicates when triaging.
- `logDeadLetter` returns `{ duplicate: boolean }` so callers can react (e.g. suppress alerting on known duplicates) if needed.
- The dedupe check is best-effort: if Redis is unreachable, the check fails soft (logged via `logger.warn`, treated as non-duplicate) rather than blocking the dead-letter write itself. Losing the dedupe signal must never cost the recoverable record, so the two failure modes are deliberately asymmetric.

> **Why atomic:** the previous implementation called `EXISTS` and then `SET`. That is a read-then-write race: two workers dead-lettering the same poison job concurrently both observe "not a duplicate", so one incident raises two alerts and the dedupe signal is unreliable exactly when a queue is under stress. `SET ... NX` collapses that into a single round trip.

## Stream retention (bounded growth)

Each dead-letter stream is written with an approximate `MAXLEN ~` cap so it cannot grow without bound. A poison message that redelivers on every deploy — or a dependency outage that fails every job in a queue — otherwise appends an entry per failure for as long as the worker is up, turning an incident into a memory-exhaustion outage on the very component that exists to record failures.

| Config env var                  | Default  | Description                                                                    |
| ------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `DEAD_LETTER_MAX_STREAM_LENGTH` | `100000` | Max entries retained per stream, trimmed approximately. `0` disables trimming. |

- A malformed value falls back to the default rather than being parsed leniently, so a typo can never silently remove the bound.
- The cap is a **retention** bound, not a correctness one. The BullMQ `failed` set (`removeOnFail: false`) remains the durable record and is unaffected.
- Each write logs the effective `maxLength` alongside `stream` and `persisted`, so an operator can confirm the bound that was in force for a given incident.
- **Rollback:** set `DEAD_LETTER_MAX_STREAM_LENGTH=0` and restart the workers to restore unbounded retention.

## When Messages Are Dead-Lettered

A message is sent to the dead letter log when:

1. **Max retries exceeded** — The queue consumer has attempted the job `maxAttempts` times and all attempts failed.
2. **Poison messages** — A message causes a non-retryable error (e.g. schema validation failure).

## Testing

A Vitest test file is colocated at `apps/workers/src/consumers/dead-letter.test.ts`. It verifies:

- `logDeadLetter` calls `logger.error` exactly once
- Structured fields (`messageId`, `queue`, `reason`, `payloadType`, `payloadHash`, `duplicate`, `timestamp`) are present in the log output
- The first dead-lettered occurrence of a payload+queue resolves `{ duplicate: false }`
- A repeat insert of the same payload+queue resolves `{ duplicate: true }`
- Different payloads hash differently, and identical payloads on different queues are not treated as duplicates of each other

The Redis service (`src/services/redis.js`) is mocked in tests via `vi.mock` + `vi.hoisted`, so dedupe behavior is verified without requiring a live Redis connection.

Run tests:

```bash
pnpm test:run
```

## Two dead-letter stores

There are **two independent** places a failed job can end up. They are not
interchangeable and have separate tooling.

| Store                             | Written by                                                            | Contains                                                                                            | Operator tool           |
| --------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------- |
| Raw streams `vatix:dead-letter:*` | `logDeadLetter()` (this module), from `settlement-worker.ts` etc.     | Messages rejected as **non-retryable** (bad payload, permanent error) before/without BullMQ retries | `pnpm replay:dlq`       |
| BullMQ `failed` set (per queue)   | BullMQ itself, when a job exhausts `attempts` (`removeOnFail: false`) | **Retry-exhausted** settlement / oracle jobs                                                        | `pnpm dlq` (issue #953) |

### BullMQ DLQ CLI (`pnpm dlq`)

`scripts/dlq.ts` (module `apps/workers/src/consumers/bullmq-dlq.ts`) is the
operator path for the BullMQ `failed` set — previously only reachable via
`redis-cli`. It resolves the queue name via `queue-config.ts`, so `--queue`
takes the alias `settlement` or `oracle`.

```bash
pnpm dlq stats     --queue settlement
pnpm dlq list      --queue oracle --limit 50
pnpm dlq retry     --queue settlement --job <jobId>
pnpm dlq retry-all --queue settlement --limit 50 --dry-run
pnpm dlq retry-all --queue settlement --limit 50 --yes
pnpm dlq discard   --queue oracle --job <jobId> --yes
```

- `retry` / `retry-all` re-queue through BullMQ (`job.retry("failed")`) so
  attempt counters and locks stay consistent — never edit Redis keys directly.
- `retry-all` collects per-job failures instead of aborting the batch and
  exits non-zero if any job could not be retried. `--dry-run` previews and
  mutates nothing.
- **State is re-verified per job.** `retry-all` calls `getState()` immediately
  before each `retry()`, even though `getFailed()` already returned only failed
  jobs. The window between listing and acting is real — a concurrent operator, a
  reconciliation job, or a redelivery can move a job in between — and
  `retry("failed")` on a job that has since completed would re-run money-path
  work that may already have settled. Such a job is reported in `failed` with
  `job is "<state>", not "failed" — refused to re-queue` and is left alone.
  `--dry-run` only reports and never re-verifies.
- **Batches are bounded.** `list` and `retry-all` clamp `--limit` to a
  maximum of `10_000`. Without a ceiling, `--limit 10000000` asks BullMQ to
  hydrate every failed job — each with its full payload — into one CLI process,
  which is a trivially reachable memory-exhaustion lever for anyone who can run
  the tool. Batch larger than that by looping.
- **Production/dev split:** in `NODE_ENV=production`, `retry-all` (non-dry-run)
  and `discard` refuse to run without `--yes` (exit code 2). Outside
  production they run unguarded for a frictionless local loop.
- Every line is structured JSON carrying a `correlationId` for the invocation;
  payloads are only surfaced by `list`, never logged by `retry`/`discard`.
- Unit tests: `apps/workers/src/consumers/bullmq-dlq.test.ts`. Integration
  test (real Redis + worker): `tests/integration/bullmq-dlq.test.ts`.

### Raw-stream replay CLI (`pnpm replay:dlq`)

`scripts/replay-dlq.ts` (pure helpers in `scripts/replay-dlq.lib.ts`) is the
operator tool for the raw `vatix:dead-letter:*` streams written by
`logDeadLetter()`. It reads each entry, re-enqueues it to **the live stream that
actually consumes that queue** (see the target table below), and removes the
entry only after the re-enqueue succeeds.

```bash
pnpm replay:dlq                                   # replay every queue
pnpm replay:dlq --queue oracle-submission          # one queue only
pnpm replay:dlq --queue oracle-submission --limit 10  # cap entries per run
pnpm replay:dlq --dry-run                           # preview, mutates nothing
pnpm replay:dlq --queue oracle-submission --yes     # confirm a production run
```

#### Replay targets

The DLQ stream name is **not** the live stream name, so the target is resolved
explicitly rather than by string-concatenating the queue name onto the key
prefix.

| DLQ queue (stream suffix) | Written by                        | Replay target                | Consumed by                                                     |
| ------------------------- | --------------------------------- | ---------------------------- | --------------------------------------------------------------- |
| `oracle-submission`       | `oracle/submission-worker.ts`     | `{prefix}oracle:submissions` | `RedisSubmissionQueue.dequeue()`                                |
| `settlement`              | `settlement/settlement-worker.ts` | **none — skipped**           | BullMQ queue `settlement-trades`; use `pnpm dlq` (#953) instead |

A queue with no live stream behind it is **skipped fail-closed**: the entries
stay in the DLQ for an operator and no bogus stream key is created. This is
deliberate — writing a settlement dead letter onto a made-up stream key would
report `replayed: 1` while nothing ever consumed the message.

Production safeguards (#1136):

- **Confirmation gate:** in `NODE_ENV=production` any run without `--dry-run`
  refuses to start unless `--yes` is passed (exit code 2) — same policy as
  `pnpm dlq`.
- **Strict arguments:** unknown flags, a malformed `--limit`, or a `--queue`
  containing glob metacharacters (`*`, `?`, `[`, ...) are usage errors (exit
  code 2) — the filter never widens a `SCAN MATCH` beyond the named stream.
- **Correlation ID:** every log line is structured JSON carrying a
  per-invocation `correlationId` for stitching an operator session back to its
  audit trail.
- **Payload redaction:** payloads are never logged — entries are identified by
  `payloadType` and `payloadHash` (SHA-256, the same algorithm as
  `logDeadLetter`), so secrets cannot leak into terminal scrollback or log
  aggregators.
- **Lossless payload round-trip:** the re-enqueued entry carries the original
  payload under a single `payload` field (`JSON.stringify(payload)`), which is
  exactly the shape the live producer writes and the live consumer reads via
  `JSON.parse(fields.payload)`. Flattening the payload's inner keys into
  top-level stream fields produced entries the consumer could not parse at all,
  and those entries were then deleted from the DLQ — silently losing the
  message.
- **Fail-closed replay:** an entry whose payload is not representable
  (primitive, array, or empty object) is _kept_ in the DLQ and counted as a
  failure — it is never deleted without a re-enqueue. Any failure during a run
  makes the script exit `1`.
- **Dedupe marks are not streams.** `logDeadLetter()` also writes a dedupe mark
  at `{prefix}dead-letter:dedupe:{queue}:{payloadHash}` (a plain **string** key,
  see "Dedupe via Payload Hash" above) on _every_ dead-letter. It lives under
  the dead-letter prefix, so `SCAN MATCH {prefix}dead-letter:*` returns it
  alongside the real streams. The CLI filters it out and never calls `XRANGE` on
  it: an `XRANGE` against a string key fails with `WRONGTYPE`, which used to
  abort the whole run with exit code 1 **before any queue was replayed** — on any
  Redis that had ever dead-lettered anything, i.e. exactly when an operator
  reaches for this tool. The marks are left untouched; they are bookkeeping for
  the 24-hour dedupe window, not messages.
- **One bad key cannot abort a run.** Each stream is read inside its own
  `try`/`catch`, so an unreadable key is logged, counted as a failure, and the
  remaining queues are still replayed. A partial replay exits `1`, so automation
  notices.
- **At-least-once:** replaying twice re-enqueues twice; dedupe lives in the
  consumers (e.g. the settlement worker's idempotency lock), never in this
  script. Always `--dry-run` first in production.
- **Re-enqueue before delete:** the entry is removed from the DLQ only after
  the `XADD` to the resolved live stream succeeds, so a crash mid-run leaves
  the entry for a second pass instead of losing the job.

Exit codes: `0` success, `1` a runtime failure or one or more entries failed to
replay, `2` invalid usage or a production run refused for lack of `--yes`. The
completion log line reports `replayed` / `failed` / `skipped` counters, so a
wrapper script can alert on a partial replay.

Every safeguard above is enforced by `scripts/replay-dlq.ts` wiring the pure
helpers in `scripts/replay-dlq.lib.ts` — the CLI imports `parseReplayArgs`,
`mutationAllowed`, `assertQueueFilter`, `fieldsToRecord`, `isReplayablePayload`,
and `payloadLogFields`, so none of the rules can be bypassed by editing the
entrypoint.

Unit tests: `tests/replay-dlq.test.ts`.

## Related Documentation

- [Architecture Overview](architecture.md) — How workers fit into the system
- [Graceful Shutdown](graceful-shutdown.md) — Worker shutdown patterns
- [Logger](logger.md) — Structured logging conventions
- [Incident Runbook — Incident 6](runbooks/incident-runbook.md#incident-6-queue-backlog-settlement--oracle-submission) — queue backlog response
