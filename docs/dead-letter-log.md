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

Every dead-lettered message is hashed (`sha256(JSON.stringify(payload))`) before it's persisted. `logDeadLetter` uses that hash to check a Redis key (`{prefix}dead-letter:dedupe:{queue}:{payloadHash}`) with a 24-hour TTL:

- If the key already exists, the message is a **duplicate** — the same payload was already dead-lettered for that queue within the last 24 hours (e.g. a retried burst of the same failure).
- The dedupe key is (re)written on every attempt, refreshing the TTL.
- Both the Redis stream entry and the structured log record `payloadHash` and `duplicate`, so replays can filter out or collapse duplicates when triaging.
- `logDeadLetter` returns `{ duplicate: boolean }` so callers can react (e.g. suppress alerting on known duplicates) if needed.
- The dedupe check is best-effort: if Redis is unreachable, the check fails soft (logged via `logger.warn`, treated as non-duplicate) rather than blocking the dead-letter write itself.

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
- **Production/dev split:** in `NODE_ENV=production`, `retry-all` (non-dry-run)
  and `discard` refuse to run without `--yes` (exit code 2). Outside
  production they run unguarded for a frictionless local loop.
- Every line is structured JSON carrying a `correlationId` for the invocation;
  payloads are only surfaced by `list`, never logged by `retry`/`discard`.
- Unit tests: `apps/workers/src/consumers/bullmq-dlq.test.ts`. Integration
  test (real Redis + worker): `tests/integration/bullmq-dlq.test.ts`.

## Related Documentation

- [Architecture Overview](architecture.md) — How workers fit into the system
- [Graceful Shutdown](graceful-shutdown.md) — Worker shutdown patterns
- [Logger](logger.md) — Structured logging conventions
- [Incident Runbook — Incident 6](runbooks/incident-runbook.md#incident-6-queue-backlog-settlement--oracle-submission) — queue backlog response
