# Graceful Shutdown

This document describes graceful shutdown patterns used across the Vatix backend to ensure clean resource cleanup and safe termination of services.

## Overview

Graceful shutdown ensures that services terminate safely by:

1. **Stopping new work acceptance** — Prevents new requests/jobs from starting
2. **Completing in-flight work** — Allows active operations to finish
3. **Cleaning up resources** — Closes database connections, timers, and other resources
4. **Exiting cleanly** — Exits the process with appropriate status code

Without graceful shutdown, services risk data loss, incomplete transactions, and orphaned connections.

## Signal Handling

Unix signals (`SIGTERM`, `SIGINT`) are used to trigger graceful shutdown:

| Signal  | Source              | Meaning                                |
| ------- | ------------------- | -------------------------------------- |
| SIGINT  | Ctrl+C in terminal  | Interrupt — user requested shutdown    |
| SIGTERM | Docker/Kubernetes   | Terminate — system requested shutdown  |
| SIGHUP  | Terminal disconnect | Hangup — terminal closed (use SIGTERM) |

Both `SIGINT` and `SIGTERM` should be handled with the same graceful shutdown logic.

## Workers Pattern

The finalization worker (and similar workers) implements a standard graceful shutdown pattern:

```typescript
// 1. Flag to prevent concurrent shutdown attempts
let isShuttingDown = false;

// 2. Shutdown function handles cleanup
const shutdown = async (signal: string) => {
  // Prevent multiple concurrent shutdowns
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info("Shutting down", { signal, component: "worker" });

  // 3. Stop accepting new work
  clearInterval(timer); // Stop the job scheduler

  // 4. Set hard timeout
  const timeoutHandle = setTimeout(() => {
    logger.error("Shutdown timeout exceeded, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    // 5. Clean up resources
    await disconnectPrisma();
    clearTimeout(timeoutHandle);

    logger.info("Shutdown complete", { component: "worker", exitCode: 0 });
    process.exit(0);
  } catch (error) {
    clearTimeout(timeoutHandle);
    logger.error("Shutdown failed", {
      component: "worker",
      exitCode: 1,
      error: error.message,
    });
    process.exit(1);
  }
};

// 6. Register signal handlers
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// 7. Start the worker
await job.run();
const timer = setInterval(() => void job.run(), intervalMs);
```

### Key Points

1. **Flag Prevention**: Use a flag to prevent concurrent shutdown handlers from running simultaneously
2. **Stop New Work**: Clear timers/intervals immediately to prevent new work from starting
3. **Hard Timeout**: 30-second timeout prevents hanging on cleanup
4. **Clean Resources**: Disconnect database clients, close connections, flush caches
5. **Log Operations**: Log shutdown progress with component names for debugging
6. **Exit Code**: Exit with 0 on success, 1 on failure
7. **Void async handlers**: Use `void` to suppress unhandled promise warnings

## Indexer Pattern

The indexer service implements graceful shutdown with cursor checkpoint flushing:

```typescript
const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info("Indexer shutdown initiated", {
    signal,
    component: "indexer",
    status: "initiated",
  });

  const timeoutHandle = setTimeout(() => {
    logger.error("Shutdown timeout exceeded, forcing exit", {
      signal,
      component: "indexer",
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    // Stop ingestion loop and FLUSH CHECKPOINT
    await ingestionLoop.stop();  // Calls flushCheckpoint(true)
    await disconnectPrisma();
    clearTimeout(timeoutHandle);

    logger.info("Indexer shutdown complete", {
      signal,
      component: "indexer",
      status: "complete",
      exitCode: 0,
    });
    process.exit(0);
  } catch (error) {
    clearTimeout(timeoutHandle);
    logger.error("Indexer shutdown failed", {
      signal,
      component: "indexer",
      status: "failed",
      exitCode: 1,
      error: error.message,
    });
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
```

### Checkpoint Flushing

The `ingestionLoop.stop()` method ensures the current cursor position is flushed to storage before shutdown:

```typescript
async stop(): Promise<void> {
  if (this.timer) {
    clearInterval(this.timer);
    this.timer = null;
  }
  if (this.heartbeatTimer) {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // Force flush checkpoint regardless of batch count
  await this.flushCheckpoint(true);

  logger.info("Indexer ingestion loop stopped", {
    finalCursor: this.cursor,
    latestIndexedLedgerSequence: this.metrics.getLatestIndexedLedgerSequence(),
  });
}
```

This ensures:
- Current ledger position is persisted on SIGTERM
- No data loss on container restart
- Indexer resumes from last known position

## API Server Pattern

The HTTP API server (Fastify) has built-in graceful shutdown support. The API server now implements coordinated graceful shutdown:

```typescript
// Graceful shutdown handling
const SHUTDOWN_TIMEOUT_MS = 30_000; // 30 seconds
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  server.log.info("API server shutdown initiated", {
    signal,
    component: "api-server",
    status: "initiated",
  });

  // Set hard timeout to force exit if shutdown hangs
  const timeoutHandle = setTimeout(() => {
    server.log.error("Shutdown timeout exceeded, forcing exit", {
      signal,
      component: "api-server",
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    // Close server — stops accepting new connections, drains in-flight requests
    await server.close();
    clearTimeout(timeoutHandle);

    server.log.info("API server shutdown complete", {
      signal,
      component: "api-server",
      status: "complete",
      exitCode: 0,
    });
    process.exit(0);
  } catch (error) {
    clearTimeout(timeoutHandle);
    server.log.error("API server shutdown failed", {
      signal,
      component: "api-server",
      status: "failed",
      exitCode: 1,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
};

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
```

### Fastify Lifecycle

- `server.close()` — Stops accepting new connections
- Active HTTP connections are drained naturally
- The server waits for in-flight requests to complete before closing
- 30-second hard timeout prevents hanging on slow requests
- Then exits cleanly

## Database Connections

All database connections must be closed during shutdown:

```typescript
import { getPrismaClient, disconnectPrisma } from "./services/prisma";

// Disconnect the singleton Prisma client
await disconnectPrisma();
```

The Prisma client handles:

- Returning active connections to the pool
- Closing the connection pool
- Waiting for in-flight queries to complete (with timeout)

**Timeout**: Prisma has a default 30-second timeout for connection cleanup.

## Redis Connections

If using Redis for caching or sessions:

```typescript
import redis from "./redis-client";

// Close the Redis connection
await redis.quit();

// OR for connection pools:
await redis.disconnect();
```

- `quit()` — Waits for pending commands, then closes
- `disconnect()` — Closes immediately without waiting

## Timeouts

Add a hard timeout to prevent the process from hanging:

```typescript
const SHUTDOWN_TIMEOUT_MS = 30_000; // 30 seconds

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info("Shutting down", { signal });

  // Set a hard timeout to force exit if cleanup hangs
  const timeoutHandle = setTimeout(() => {
    logger.error("Shutdown timeout exceeded, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    // Cleanup operations
    await disconnectPrisma();
    clearTimeout(timeoutHandle);

    logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("Shutdown failed", { error: error.message });
    process.exit(1);
  }
};
```

## Testing Graceful Shutdown

### Docker/Kubernetes

```bash
# Send SIGTERM signal to the container
docker stop <container> # Sends SIGTERM

# Or:
kubectl delete pod <pod> --grace-period=30
```

### Local Development

```bash
# Start the server
npm run dev

# In another terminal, send SIGTERM
kill -TERM <pid>

# Or press Ctrl+C (sends SIGINT)
```

### Verify Shutdown

Check logs for:

- `"Shutting down"` — Signal was received
- `"Shutdown complete"` — Cleanup finished successfully
- Exit code 0 — Process exited cleanly

```bash
# Check exit code of last command
echo $?  # 0 = success, 1 = failure
```

## Worker Bootstrap Example

Complete working example:

```typescript
import { Logger } from "@vatix/shared";
import { getPrismaClient, disconnectPrisma } from "./services/prisma";

interface JobConfig {
  intervalMs: number;
  logLevel: LogLevel;
}

async function bootstrap(): Promise<void> {
  const config: JobConfig = loadConfig();
  const logger = new Logger("MyWorker", config.logLevel);
  const prisma = getPrismaClient();
  const job = new MyJob(prisma, logger);

  logger.info("Worker started", { interval: config.intervalMs });

  // Run job once immediately
  await job.run();

  // Schedule recurring execution
  const timer = setInterval(() => void job.run(), config.intervalMs);

  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("Worker shutting down", { signal });
    clearInterval(timer); // Stop scheduler

    try {
      // Clean up resources
      await disconnectPrisma();

      logger.info("Worker shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error("Worker shutdown failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  // Register signal handlers
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Start the worker
void bootstrap().catch((error) => {
  console.error("Bootstrap failed:", error);
  process.exit(1);
});
```

## Best Practices

1. **Always register handlers** — Handle both SIGINT and SIGTERM
2. **Use flags** — Prevent concurrent shutdown attempts
3. **Log everything** — Include signal and completion status
4. **Set timeouts** — Prevent hanging on cleanup
5. **Test it** — Verify graceful shutdown works in your environment
6. **Clean up resources** — Always disconnect database, cache, and other clients
7. **Exit with status** — 0 for success, 1 for failure
8. **Monitor exit codes** — Use process exit code for alerting and restarting

## Environment Considerations

### Local Development

- Processes should exit immediately on Ctrl+C
- Check logs to verify shutdown sequence

### Docker

- Docker sends SIGTERM on `docker stop` (default 10 second timeout)
- Set container `stopSignal` to SIGTERM if needed
- Verify shutdown completes within timeout

```dockerfile
# In Dockerfile
STOPSIGNAL SIGTERM
```

### Kubernetes

- Pods receive SIGTERM on deletion
- Grace period (default 30 seconds) allows shutdown
- Configure health check to fail during shutdown

```yaml
# In pod spec
terminationGracePeriodSeconds: 30
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 5"]
```

### Process Managers

- PM2, systemd, supervisor all support graceful restart
- Ensure handler processes the correct signal
- Verify exit code is used for restart logic

## Troubleshooting

### Process hangs on shutdown

- Add shutdown timeout to force exit
- Check logs for cleanup operation hanging
- Review database/cache connection cleanup

### Data loss on shutdown

- Verify all in-flight operations complete before exiting
- Check if transactions are being rolled back
- Add pre-shutdown flush operations

### Connections not closed

- Check `disconnectPrisma()` is being called
- Verify Redis/cache clients are disconnected
- Use `lsof` to check open file descriptors

```bash
lsof -i -P -n | grep <process-name>
```

## Related Documentation

- [Logger](logger.md)
- [Architecture Overview](architecture.md)
- [Docker Compose Setup](docker-compose.md)
- [Deployment Runbook](deployment-runbook.md)

## Implementation Status

All services in the Vatix backend now implement coordinated graceful shutdown:

### ✅ API Server (`src/index.ts`)
- Stops accepting new connections on SIGTERM/SIGINT
- Drains in-flight HTTP requests
- 30-second hard timeout
- Structured logging with component identifier

### ✅ Indexer (`apps/indexer/src/main.ts`)
- Stops ingestion loop on SIGTERM/SIGINT
- Forces checkpoint flush via `flushCheckpoint(true)`
- Disconnects database connections
- 30-second hard timeout
- Structured logging with component identifier

### ✅ Finalization Worker (`apps/workers/src/finalization/main.ts`)
- Stops job timer on SIGTERM/SIGINT
- Disconnects database connections
- 30-second hard timeout
- Structured logging with component identifier

### ✅ Oracle Worker (`apps/workers/src/oracle/main.ts`)
- Stops polling timer on SIGTERM/SIGINT
- Disconnects database and Redis connections
- 30-second hard timeout
- Structured logging with component identifier

### ✅ Docker Configuration (`docker-compose.yml`)
- All services configured with `stop_signal: SIGTERM`
- Grace periods set to 30s (postgres) and 10s (redis)
- Matches application-level timeout expectations
