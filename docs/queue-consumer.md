# Queue Consumer

This document describes the generic queue consumer used by the workers module.

## Overview

The queue consumer lives in `apps/workers/src/consumers/queue-consumer.ts`. It processes jobs from a named queue, handles retries, and dead-letters jobs that exhaust all attempts. All log output uses structured fields at appropriate log levels so it integrates cleanly with the project's JSON logging pipeline.

## API

### `QueueJob`

Represents a single job pulled from the queue.

| Field      | Type                       | Description                              |
| ---------- | -------------------------- | ---------------------------------------- |
| `id`       | `string`                   | Unique job identifier                    |
| `payload`  | `Record<string, unknown>`  | Arbitrary job data                       |
| `attempts` | `number`                   | Delivery attempt count (starts at 1)     |

### `QueueConsumerConfig`

Configuration passed to `processJob`.

| Field                  | Type     | Description                                           |
| ---------------------- | -------- | ----------------------------------------------------- |
| `queueName`            | `string` | Logical queue name (e.g. `"settlement"`)              |
| `maxAttempts`          | `number` | Maximum delivery attempts before dead-lettering       |
| `processingTimeoutMs`  | `number` | Per-job processing timeout in milliseconds            |

### `JobHandler`

```typescript
type JobHandler = (job: QueueJob) => Promise<void>;
```

An async function that receives a job and either resolves (success) or throws (failure).

### `processJob(logger, config, job, handler)`

Processes a single job with structured logging and retry semantics.

```typescript
import { processJob } from "./consumers/queue-consumer.js";

await processJob(logger, config, job, async (job) => {
  // handle job.payload
});
```

## Log Levels

| Event                         | Level   |
| ----------------------------- | ------- |
| Job received                  | `info`  |
| Job completed successfully    | `info`  |
| Failure with retries remaining | `warn` |
| Failure at max attempts       | `error` |

## Retry and Dead-Letter Flow

```
Job received
    │
    ▼
handler(job)
    │
    ├─ success ──► log info "Job processed successfully"
    │
    └─ error
           │
           ├─ attempts < maxAttempts ──► log warn "will retry", re-throw
           │
           └─ attempts >= maxAttempts ──► log error "max attempts exceeded", re-throw
                                              │
                                              ▼
                                       logDeadLetter(...)
```

When `processJob` re-throws after the final attempt, the caller is responsible for invoking [`logDeadLetter`](dead-letter-log.md) to record the terminal failure.

## Example

```typescript
import { processJob, type QueueConsumerConfig, type QueueJob } from "./consumers/queue-consumer.js";

const config: QueueConsumerConfig = {
  queueName: "settlement",
  maxAttempts: 3,
  processingTimeoutMs: 5_000,
};

const job: QueueJob = {
  id: "job-001",
  payload: { tradeId: "t-789" },
  attempts: 1,
};

await processJob(logger, config, job, async (j) => {
  // business logic here
});
```

## Related Documentation

- [Dead Letter Log](dead-letter-log.md) — What happens after max retries
- [Graceful Shutdown](graceful-shutdown.md) — Worker shutdown patterns
- [Logger](logger.md) — Structured logging conventions
- [Architecture Overview](architecture.md) — How workers fit into the system
