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

logDeadLetter(logger, message);
// => logger.error("Job dead-lettered", { messageId, queue, reason, payloadType, timestamp })
```

**Log fields emitted:**

| Field         | Source                     | Description                              |
| ------------- | -------------------------- | ---------------------------------------- |
| `messageId`   | `message.id`               | Correlates with upstream job ID          |
| `queue`       | `message.queue`            | Which queue the message came from        |
| `reason`      | `message.reason`           | Why the message was dead-lettered        |
| `payloadType` | `typeof message.payload`   | JS type of the payload (e.g. `"object"`) |
| `timestamp`   | `new Date().toISOString()` | When the dead letter was recorded        |

> **Note:** The `payload` value is intentionally **not** logged to avoid leaking sensitive data. `payloadType` gives operators enough context to distinguish missing payloads from structured ones. If you need payload details, inspect the dead letter store or enable `debug`-level logging upstream.

## When Messages Are Dead-Lettered

A message is sent to the dead letter log when:

1. **Max retries exceeded** — The queue consumer has attempted the job `maxAttempts` times and all attempts failed.
2. **Poison messages** — A message causes a non-retryable error (e.g. schema validation failure).

## Testing

A Vitest test file is colocated at `apps/workers/src/consumers/dead-letter.test.ts`. It verifies:

- `logDeadLetter` calls `logger.error` exactly once
- Structured fields (`messageId`, `queue`, `reason`, `payloadType`, `timestamp`) are present in the log output

Run tests:

```bash
pnpm test:run
```

## Related Documentation

- [Architecture Overview](architecture.md) — How workers fit into the system
- [Graceful Shutdown](graceful-shutdown.md) — Worker shutdown patterns
- [Logger](logger.md) — Structured logging conventions
