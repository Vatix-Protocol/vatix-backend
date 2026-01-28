import Redis from "ioredis";

/**
 * Represents a trade record to be logged
 */
export interface TradeRecord {
  timestamp: number; // Unix timestamp in milliseconds
  buyer: string; // User ID
  seller: string; // User ID
  price: number; // Trade execution price
  quantity: number; // Number of shares traded
  marketId: string; // Market identifier
  outcome: string; // Outcome being traded
}

/**
 * Represents a logged audit entry with additional metadata
 */
export interface AuditLogEntry extends TradeRecord {
  sequentialId: string; // Redis Stream ID (timestamp-sequence)
  streamId: string; // Full Redis Stream entry ID
}

/**
 * Query parameters for retrieving audit logs
 */
export interface AuditLogQuery {
  marketId: string;
  limit?: number; // Default: 100, Max: 1000
  startId?: string; // For pagination
  endId?: string; // For range queries
}

/**
 * Base error class for audit log operations
 */
export class AuditLogError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AuditLogError";
  }
}

/**
 * Error thrown when trade record validation fails
 */
export class ValidationError extends AuditLogError {
  constructor(field: string, value: any) {
    super(`Invalid ${field}: ${value}`, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

/**
 * Error thrown when Redis connection fails
 */
export class RedisConnectionError extends AuditLogError {
  constructor(originalError: Error) {
    super(
      `Redis connection failed: ${originalError.message}`,
      "REDIS_CONNECTION_ERROR",
    );
    this.name = "RedisConnectionError";
  }
}

/**
 * Audit Log Service for recording and retrieving trade executions
 * Uses Redis Streams for immutable, append-only logging
 */
export class AuditLogService {
  private readonly STREAM_KEY_PREFIX = "audit:market:";
  private readonly MAX_RETRIES = 3;
  private readonly RETENTION_DAYS = 30;

  constructor(private readonly redisClient: Redis) {}

  /**
   * Log a trade execution to Redis Streams
   * @param trade Trade record to log
   * @returns Promise resolving to the stream entry ID
   */
  async logTrade(trade: TradeRecord): Promise<string> {
    this.validateTradeRecord(trade);

    const streamKey = `${this.STREAM_KEY_PREFIX}${trade.marketId}`;
    const fields = {
      timestamp: trade.timestamp.toString(),
      buyer: trade.buyer,
      seller: trade.seller,
      price: trade.price.toString(),
      quantity: trade.quantity.toString(),
      outcome: trade.outcome,
      sequentialId: "*", // Redis will auto-generate
    };

    return this.retryWithBackoff(async () => {
      try {
        const streamId = await this.redisClient.xadd(
          streamKey,
          "*",
          ...Object.entries(fields).flat(),
        );
        return streamId as string;
      } catch (error) {
        if (error instanceof Error && error.message.includes("connection")) {
          throw new RedisConnectionError(error);
        }
        throw error;
      }
    });
  }

  /**
   * Retrieve audit logs for a specific market
   * @param marketId Market identifier
   * @param limit Maximum number of entries to return (default: 100, max: 1000)
   * @returns Promise resolving to array of audit log entries
   */
  async getAuditLog(
    marketId: string,
    limit: number = 100,
  ): Promise<AuditLogEntry[]> {
    if (!marketId || typeof marketId !== "string") {
      throw new ValidationError("marketId", marketId);
    }

    const actualLimit = Math.min(Math.max(1, limit), 1000);
    const streamKey = `${this.STREAM_KEY_PREFIX}${marketId}`;

    return this.retryWithBackoff(async () => {
      try {
        // Use XREVRANGE to get entries in reverse chronological order (newest first)
        const entries = await this.redisClient.xrevrange(
          streamKey,
          "+",
          "-",
          "COUNT",
          actualLimit,
        );

        return entries.map(([streamId, fields]) => {
          const fieldMap = this.fieldsArrayToObject(fields);
          return {
            sequentialId: streamId,
            streamId,
            timestamp: parseInt(fieldMap.timestamp),
            buyer: fieldMap.buyer,
            seller: fieldMap.seller,
            price: parseFloat(fieldMap.price),
            quantity: parseFloat(fieldMap.quantity),
            marketId,
            outcome: fieldMap.outcome,
          };
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("connection")) {
          throw new RedisConnectionError(error);
        }
        throw error;
      }
    });
  }

  /**
   * Validate trade record before logging
   * @param trade Trade record to validate
   * @throws ValidationError if validation fails
   */
  private validateTradeRecord(trade: TradeRecord): void {
    if (!trade) {
      throw new ValidationError("trade", trade);
    }

    if (
      !trade.timestamp ||
      typeof trade.timestamp !== "number" ||
      trade.timestamp <= 0
    ) {
      throw new ValidationError("timestamp", trade.timestamp);
    }

    if (!trade.buyer || typeof trade.buyer !== "string") {
      throw new ValidationError("buyer", trade.buyer);
    }

    if (!trade.seller || typeof trade.seller !== "string") {
      throw new ValidationError("seller", trade.seller);
    }

    if (typeof trade.price !== "number" || trade.price <= 0) {
      throw new ValidationError("price", trade.price);
    }

    if (typeof trade.quantity !== "number" || trade.quantity <= 0) {
      throw new ValidationError("quantity", trade.quantity);
    }

    if (!trade.marketId || typeof trade.marketId !== "string") {
      throw new ValidationError("marketId", trade.marketId);
    }

    if (!trade.outcome || typeof trade.outcome !== "string") {
      throw new ValidationError("outcome", trade.outcome);
    }
  }

  /**
   * Retry operation with exponential backoff
   * @param operation Operation to retry
   * @param maxRetries Maximum number of retries
   * @returns Promise resolving to operation result
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = this.MAX_RETRIES,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (attempt === maxRetries) break;

        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new AuditLogError(
      `Operation failed after ${maxRetries} retries: ${lastError?.message || "Unknown error"}`,
      "MAX_RETRIES_EXCEEDED",
    );
  }

  /**
   * Convert Redis fields array to object
   * @param fields Array of field-value pairs from Redis
   * @returns Object with field names as keys
   */
  private fieldsArrayToObject(fields: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      result[fields[i]] = fields[i + 1];
    }
    return result;
  }
}
