import Redis from "ioredis";

const ORDER_BOOK_TTL = 60; // seconds

/**
 * Reads REDIS_KEY_PREFIX from the environment (default: "vatix:").
 * All Redis keys produced by RedisService are namespaced under this prefix so
 * that multiple environments (dev/staging/prod) can safely share a single Redis
 * instance without key collisions.
 *
 * Override via environment variable:
 *   REDIS_KEY_PREFIX  — key namespace prefix (default: "vatix:")
 */
function loadKeyPrefix(): string {
  const raw = process.env.REDIS_KEY_PREFIX;
  if (raw !== undefined && raw !== null) return raw; // allow empty string (no prefix)
  return "vatix:";
}

/**
 * Redis connection retry defaults.
 * Override via environment variables:
 *   REDIS_MAX_RETRIES        — max retry attempts before giving up (default: 3)
 *   REDIS_RETRY_BASE_DELAY   — base delay in ms for exponential backoff (default: 100)
 *   REDIS_RETRY_MAX_DELAY    — cap on retry delay in ms (default: 2000)
 *   REDIS_CONNECT_TIMEOUT    — socket connect timeout in ms (default: 5000)
 */
function loadRetryConfig(): {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  connectTimeout: number;
} {
  function parsePositiveInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  return {
    maxRetries: parsePositiveInt("REDIS_MAX_RETRIES", 3),
    baseDelay: parsePositiveInt("REDIS_RETRY_BASE_DELAY", 100),
    maxDelay: parsePositiveInt("REDIS_RETRY_MAX_DELAY", 2000),
    connectTimeout: parsePositiveInt("REDIS_CONNECT_TIMEOUT", 5000),
  };
}

/**
 * Order book data structure for caching
 */
export interface OrderBookData {
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
  timestamp: number;
}

/**
 * RedisService provides caching capabilities for order book data
 * and real-time market information
 */
class RedisService {
  private client: Redis | null = null;
  private isConnecting = false;
  private retryCount = 0;
  /**
   * Key prefix applied to all keys managed by this service.
   * Loaded once at construction from REDIS_KEY_PREFIX (default: "vatix:").
   * Callers that build their own stream keys should prepend this prefix so all
   * keys live in the same namespace.
   */
  readonly keyPrefix: string;

  constructor() {
    this.keyPrefix = loadKeyPrefix();
  }

  /**
   * Returns a key string with the configured key prefix applied.
   * Use this helper when building stream keys or other Redis keys outside the
   * service so they are consistently namespaced.
   *
   * @param key - Bare key without prefix (e.g. "settlement-trades")
   * @returns Prefixed key (e.g. "vatix:settlement-trades")
   */
  prefixed(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Get Redis client instance, creating if necessary
   */
  private getClient(): Redis {
    if (!this.client) {
      this.connect();
    }
    return this.client!;
  }

  /**
   * Connect to Redis with retry strategy
   */
  private connect(): void {
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        throw new Error("REDIS_URL environment variable is not set");
      }

      const { maxRetries, baseDelay, maxDelay, connectTimeout } =
        loadRetryConfig();

      this.client = new Redis(redisUrl, {
        maxRetriesPerRequest: maxRetries,
        connectTimeout,
        retryStrategy: (times: number) => {
          if (times > maxRetries) {
            console.error(
              { service: "redis", maxRetries },
              "Redis max retries exceeded, giving up"
            );
            return null; // stop retrying
          }
          const delay = Math.min(baseDelay * Math.pow(2, times - 1), maxDelay);
          console.warn(
            { service: "redis", attempt: times, delayMs: delay },
            "Redis connection retry scheduled"
          );
          return delay;
        },
        lazyConnect: false,
      });

      this.client.on("connect", () => {
        console.info({ service: "redis" }, "Redis connected");
        this.retryCount = 0;
      });

      this.client.on("error", (err: Error) => {
        console.error(
          { service: "redis", err: err.message },
          "Redis connection error"
        );
      });

      this.client.on("reconnecting", () => {
        this.retryCount++;
        console.warn(
          { service: "redis", attempt: this.retryCount },
          "Redis reconnecting"
        );
      });

      this.client.on("close", () => {
        console.info({ service: "redis" }, "Redis connection closed");
      });
    } finally {
      this.isConnecting = false;
    }
  }

  // ==================== Basic Methods ====================

  /**
   * Get a value by key
   */
  async get(key: string): Promise<string | null> {
    try {
      return await this.getClient().get(key);
    } catch (error) {
      console.error({ service: "redis", key, err: error }, "Redis GET failed");
      throw error;
    }
  }

  /**
   * Set a value with optional TTL
   * @param key - Cache key
   * @param value - Value to store
   * @param ttl - Time to live in seconds (optional)
   */
  async set(key: string, value: string, ttl?: number): Promise<void> {
    try {
      if (ttl) {
        await this.getClient().set(key, value, "EX", ttl);
      } else {
        await this.getClient().set(key, value);
      }
    } catch (error) {
      console.error({ service: "redis", key, err: error }, "Redis SET failed");
      throw error;
    }
  }

  /**
   * Delete a key
   */
  async del(key: string): Promise<void> {
    try {
      await this.getClient().del(key);
    } catch (error) {
      console.error({ service: "redis", key, err: error }, "Redis DEL failed");
      throw error;
    }
  }

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.getClient().exists(key);
      return result === 1;
    } catch (error) {
      console.error(
        { service: "redis", key, err: error },
        "Redis EXISTS failed"
      );
      throw error;
    }
  }

  // ==================== Order Book Methods ====================

  /**
   * Build order book cache key
   */
  private buildOrderBookKey(marketId: string, outcome: string): string {
    return `${this.keyPrefix}orderbook:${marketId}:${outcome}`;
  }

  /**
   * Store order book data with 60 second TTL
   */
  async setOrderBook(
    marketId: string,
    outcome: string,
    data: OrderBookData
  ): Promise<void> {
    const key = this.buildOrderBookKey(marketId, outcome);
    try {
      await this.set(key, JSON.stringify(data), ORDER_BOOK_TTL);
    } catch (error) {
      console.error(
        { service: "redis", marketId, outcome, err: error },
        "Redis setOrderBook failed"
      );
      throw error;
    }
  }

  /**
   * Retrieve order book data
   */
  async getOrderBook(
    marketId: string,
    outcome: string
  ): Promise<OrderBookData | null> {
    const key = this.buildOrderBookKey(marketId, outcome);
    try {
      const data = await this.get(key);
      if (!data) return null;
      return JSON.parse(data) as OrderBookData;
    } catch (error) {
      console.error(
        { service: "redis", marketId, outcome, err: error },
        "Redis getOrderBook failed"
      );
      throw error;
    }
  }

  /**
   * Clear all order books for a market (matches pattern {prefix}orderbook:{marketId}:*)
   */
  async clearOrderBook(marketId: string): Promise<void> {
    const pattern = `${this.keyPrefix}orderbook:${marketId}:*`;
    try {
      const keys = await this.getClient().keys(pattern);
      if (keys.length > 0) {
        await this.getClient().del(...keys);
      }
    } catch (error) {
      console.error(
        { service: "redis", marketId, err: error },
        "Redis clearOrderBook failed"
      );
      throw error;
    }
  }

  // ==================== Utility Methods ====================

  /**
   * Check Redis connectivity
   */
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.getClient().ping();
      return result === "PONG";
    } catch (error) {
      console.error(
        { service: "redis", err: error },
        "Redis health check failed"
      );
      return false;
    }
  }

  /**
   * Gracefully close Redis connection
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.retryCount = 0;
      console.info({ service: "redis" }, "Redis disconnected gracefully");
    }
  }

  /**
   * Create a consumer group for a stream
   */
  async xgroup(
    subcommand: "CREATE",
    key: string,
    groupName: string,
    id: string,
    options?: { MKSTREAM?: boolean }
  ): Promise<string | void> {
    try {
      const client = this.getClient();
      const args = [subcommand, key, groupName, id];
      if (options?.MKSTREAM) {
        args.push("MKSTREAM");
      }
      return await (client.xgroup as any)(...args);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes("BUSYGROUP")) {
        return; // Group already exists, which is OK
      }
      console.error({ service: "redis", err: error }, "Redis XGROUP failed");
      throw error;
    }
  }

  /**
   * Add entry to Redis Stream
   */
  async xadd(...args: (string | number)[]): Promise<string | null> {
    try {
      const client = this.getClient();
      return await (client.xadd as any)(...args);
    } catch (error) {
      console.error({ service: "redis", err: error }, "Redis XADD failed");
      throw error;
    }
  }

  /**
   * Read range from Redis Stream (oldest to newest)
   */
  async xrange(
    key: string,
    start: string,
    end: string,
    countArg?: "COUNT",
    limit?: string
  ): Promise<Array<[string, string[]]>> {
    try {
      if (countArg && limit) {
        return await this.getClient().xrange(key, start, end, countArg, limit);
      } else {
        return await this.getClient().xrange(key, start, end);
      }
    } catch (error) {
      console.error(
        { service: "redis", key, err: error },
        "Redis XRANGE failed"
      );
      throw error;
    }
  }

  /**
   * Read range from Redis Stream (newest to oldest)
   */
  async xrevrange(
    key: string,
    start: string,
    end: string,
    countArg?: "COUNT",
    limit?: string
  ): Promise<Array<[string, string[]]>> {
    try {
      if (countArg && limit) {
        return await this.getClient().xrevrange(
          key,
          start,
          end,
          countArg,
          limit
        );
      } else {
        return await this.getClient().xrevrange(key, start, end);
      }
    } catch (error) {
      console.error(
        { service: "redis", key, err: error },
        "Redis XREVRANGE failed"
      );
      throw error;
    }
  }

  /**
   * Read from a consumer group (blocking)
   */
  async xreadgroup(
    groupName: string,
    consumerName: string,
    streamKey: string,
    id: string,
    options?: { COUNT?: number; BLOCK?: number }
  ): Promise<Array<[string, Array<[string, string[]]>]>> {
    try {
      const client = this.getClient();
      const args = ["GROUP", groupName, consumerName];
      if (options?.COUNT) {
        args.push("COUNT", String(options.COUNT));
      }
      if (options?.BLOCK) {
        args.push("BLOCK", String(options.BLOCK));
      }
      args.push("STREAMS", streamKey, id);
      return await (client.xreadgroup as any)(...args);
    } catch (error) {
      console.error(
        { service: "redis", err: error },
        "Redis XREADGROUP failed"
      );
      throw error;
    }
  }

  /**
   * Acknowledge a message in a consumer group
   */
  async xack(
    streamKey: string,
    groupName: string,
    ...messageIds: string[]
  ): Promise<number> {
    try {
      const client = this.getClient();
      return await (client.xack as any)(streamKey, groupName, ...messageIds);
    } catch (error) {
      console.error({ service: "redis", err: error }, "Redis XACK failed");
      throw error;
    }
  }

  /**
   * Claim messages from a consumer group (visibility timeout)
   */
  async xclaim(
    streamKey: string,
    groupName: string,
    consumerName: string,
    minIdleTimeMs: number,
    ...messageIds: string[]
  ): Promise<Array<[string, string[]]>> {
    try {
      const client = this.getClient();
      const args = [
        streamKey,
        groupName,
        consumerName,
        minIdleTimeMs,
        ...messageIds,
      ];
      return await (client.xclaim as any)(...args);
    } catch (error) {
      console.error({ service: "redis", err: error }, "Redis XCLAIM failed");
      throw error;
    }
  }

  /**
   * Get stream info
   */
  async xinfo(subcommand: "STREAM", key: string): Promise<any> {
    try {
      return await this.getClient().xinfo(subcommand, key);
    } catch (error) {
      console.error(
        { service: "redis", key, err: error },
        "Redis XINFO failed"
      );
      throw error;
    }
  }
}

/**
 * Singleton instance of RedisService
 */
export const redis = new RedisService();

export { RedisService };
export { matchingService } from "../matching/matching-service.js";
