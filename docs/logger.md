# Logger

The logger module provides a lightweight, configurable logging utility for the Vatix backend.

## Overview

The `Logger` class is a structured logging interface that supports multiple log levels and message prefixing. It's designed to be simple and efficient without external dependencies.

## Features

- **Multiple Log Levels**: `debug`, `info`, `warn`, `error`
- **Level Filtering**: Only logs messages at or above the configured level
- **Message Prefixing**: Organize logs by component with optional prefixes
- **Child Loggers**: Create hierarchical loggers for better organization
- **Environment Configuration**: Configurable via `LOG_LEVEL` environment variable

## Usage

### Basic Logger Creation

```typescript
import { Logger } from "@vatix/shared";

// Create a logger with optional prefix
const logger = new Logger("MyComponent");

// Log messages at different levels
logger.debug("Debug information");
logger.info("Information message");
logger.warn("Warning message");
logger.error("Error message");
```

### Log Levels

The logger supports four levels, in order of severity:

| Level | Usage                                    |
| ----- | ---------------------------------------- |
| debug | Detailed diagnostic information          |
| info  | General informational messages (default) |
| warn  | Warning conditions                       |
| error | Error conditions                         |

When you set a log level, only messages at that level or higher severity are logged:

```typescript
// With LOG_LEVEL=info, this is logged
logger.info("This will be logged");

// But this is not logged
logger.debug("This will NOT be logged");
```

### Configuration via Environment Variable

Set the `LOG_LEVEL` environment variable to control the global logging level:

```bash
# Only log info, warn, and error
export LOG_LEVEL=info

# Only log errors and warnings
export LOG_LEVEL=warn

# Log everything including debug
export LOG_LEVEL=debug
```

**Default**: `info`

If an invalid `LOG_LEVEL` is provided, a warning is written to stderr and the logger falls back to `info`.

### Specifying Level in Constructor

```typescript
import { Logger } from "@vatix/shared";

// Create logger with specific level (overrides env var)
const debugLogger = new Logger("ComponentA", "debug");
const errorLogger = new Logger("ComponentB", "error");
```

### Message Prefixes

Prefixes help organize logs by component and source:

```typescript
const logger = new Logger("API");

logger.info("Server starting");
// Output: [API] Server starting

const dbLogger = logger.child("Database");
logger.info("Connected");
// Output: [API:Database] Connected
```

### Child Loggers

Create hierarchical loggers for better organization:

```typescript
const rootLogger = new Logger("App");
const apiLogger = rootLogger.child("API");
const marketLogger = apiLogger.child("Markets");

marketLogger.info("Fetching markets");
// Output: [App:API:Markets] Fetching markets
```

## Logger API

### Constructor

```typescript
constructor(prefix: string = "", level?: LogLevel)
```

- `prefix`: Optional prefix for all messages from this logger
- `level`: Optional log level (overrides `LOG_LEVEL` env var)

### Methods

#### `debug(msg: string): void`

Log a debug-level message.

```typescript
logger.debug("Variable value: " + value);
```

#### `info(msg: string): void`

Log an info-level message.

```typescript
logger.info("Operation completed successfully");
```

#### `warn(msg: string): void`

Log a warning-level message.

```typescript
logger.warn("Retry attempt 3 of 5");
```

#### `error(msg: string): void`

Log an error-level message.

```typescript
logger.error("Connection failed: " + error.message);
```

#### `child(childPrefix: string): Logger`

Create a child logger with an extended prefix.

```typescript
const childLogger = logger.child("SubComponent");
// Prefix will be: "ParentComponent:SubComponent"
```

Returns a new `Logger` instance that inherits the parent's log level.

## Examples

### API Route Logging

```typescript
import { Logger } from "@vatix/shared";

const logger = new Logger("MarketsRoute");

export async function getMarkets(request, reply) {
  logger.info("GET /v1/markets request received");

  try {
    const markets = await fetchMarkets();
    logger.debug(`Found ${markets.length} markets`);
    return reply.send(markets);
  } catch (error) {
    logger.error(`Failed to fetch markets: ${error.message}`);
    return reply.status(500).send({ error: "Internal server error" });
  }
}
```

### Background Worker Logging

```typescript
import { Logger } from "@vatix/shared";

const logger = new Logger("SettlementWorker");

async function processSettlements() {
  logger.info("Starting settlement batch");

  try {
    const settlements = await getSettlements();
    logger.debug(`Processing ${settlements.length} settlements`);

    for (const settlement of settlements) {
      try {
        await execute(settlement);
        logger.debug(`Settlement ${settlement.id} executed`);
      } catch (error) {
        logger.warn(`Settlement ${settlement.id} failed: ${error.message}`);
      }
    }

    logger.info("Settlement batch completed");
  } catch (error) {
    logger.error(`Settlement batch failed: ${error.message}`);
  }
}
```

### Database Operations Logging

```typescript
import { Logger } from "@vatix/shared";

const dbLogger = new Logger("Database");

export class Repository {
  private logger = dbLogger.child("OrderRepository");

  async findOrder(id: string) {
    this.logger.debug(`Querying order: ${id}`);
    try {
      const order = await db.order.findUnique({ where: { id } });
      if (!order) {
        this.logger.warn(`Order not found: ${id}`);
      }
      return order;
    } catch (error) {
      this.logger.error(`Query failed for order ${id}: ${error.message}`);
      throw error;
    }
  }
}
```

## Best Practices

1. **Use Appropriate Levels**:
   - `debug`: Development and troubleshooting only
   - `info`: Important milestones and state changes
   - `warn`: Recoverable issues and degraded conditions
   - `error`: Failures and exceptions

2. **Use Meaningful Prefixes**: Organize logs by component for easier debugging

3. **Avoid Sensitive Data**: Never log passwords, API keys, or user credentials

4. **Keep Messages Clear**: Use descriptive, human-readable messages

5. **Use Child Loggers**: For nested components, use child loggers to maintain hierarchy

## Internal Usage

The shared module also exports a utility function for internal logging:

```typescript
import { log } from "@vatix/shared";

log("message", value);
// Output: [shared] message value
```

## See Also

- [Environment Variables](./configuration.md)
- [Architecture Overview](./architecture.md)
