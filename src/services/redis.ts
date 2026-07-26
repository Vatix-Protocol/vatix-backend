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
  private connectionPromise: Promise<Redis> | null = null;
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
   * Get the connected Redis client, establishing (or awaiting) the
   * connection first if necessary.
   *
   * Every method that talks to Redis must go through this helper instead of
   * reading `this.client` directly — reading `this.client` before the
   * connection promise resolves (e.g. the very first call after startup, or
   * any call issued right after a "close" event resets the client) returns
   * `null` and crashes the caller. Routing everything through the pending
   * `connectionPromise` makes those states resolve gracefully instead.
   */
  /**
   * Return the active Redis client instance.
   * Throws if the client is not yet connected or has been closed.
   * Always call `ensureConnected()` before using this method so
   * the connection is guaranteed to be live.
   */
  private getClient(): Redis {
    if (!this.client) {
      throw new Error(
        "Redis client is not connected. Call ensureConnected() first."
      );
    }
    return this.client;
  }

  private async ensureConnected(): Promise<Redis> {
    if (!this.client) {
      if (!this.connectionPromise) {
        this.connectionPromise = this.connect();
      }
      await this.connectionPromise;
    }
    return this.getClient();
  }

  /**
   * Connect to Redis with retry strategy, returning a promise that resolves when connected
   */
  private connect(): Promise<Redis> {
    return new Promise((resolve, reject) => {
      try {
        const redisUrl = process.env.REDIS_URL;
        if (!redisUrl) {
          const error = new Error("REDIS_URL environment variable is not set");
          reject(error);
          return;
        }

        const { maxRetries, baseDelay, maxDelay, connectTimeout } =
          loadRetryConfig();

        const client = new Redis(redisUrl, {
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
            const delay = Math.min(
              baseDelay * Math.pow(2, times - 1),
              maxDelay
            );
            console.warn(
              { service: "redis", attempt: times, delayMs: delay },
              "Redis connection retry scheduled"
            );
            return delay;
          },
          lazyConnect: false,
        });

        let isResolved = false;

        const onConnect = () => {
          if (!isResolved) {
            isResolved = true;
            this.client = client;
            console.info({ service: "redis" }, "Redis connected");
            this.retryCount = 0;
            resolve(client);
          }
        };

        const onError = (err: Error) => {
          console.error(
            { service: "redis", err: err.message },
            "Redis connection error"
          );
          if (!isResolved) {
            isResolved = true;
            this.client = null;
            this.connectionPromise = null;
            reject(err);
          }
        };

        const onReconnecting = () => {
          this.retryCount++;
          console.warn(
            { service: "redis", attempt: this.retryCount },
            "Redis reconnecting"
          );
        };

        const onClose = () => {
          console.info({ service: "redis" }, "Redis connection closed");
          // Reset client and connection promise to allow reconnection
          this.client = null;
          this.connectionPromise = null;
        };

        client.on("connect", onConnect);
        client.on("error", onError);
        client.on("reconnecting", onReconnecting);
        client.on("close", onClose);
      } catch (error) {
        reject(error);
      }
    });
  }

  // ==================== Basic Methods ====================

  /**
   * Get a value by key
   */
  async get(key: string): Promise<string | null> {
    try {
      const client = await this.ensureConnected();
      return await client.get(key);
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
      const client = await this.ensureConnected();
      if (ttl) {
        await client.set(key, value, "EX", ttl);
      } else {
        await client.set(key, value);
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
      const client = await this.ensureConnected();
      await client.del(key);
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
      const client = await this.ensureConnected();
      const result = await client.exists(key);
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
      const client = await this.ensureConnected();
      const keys = await client.keys(pattern);
      if (keys.length > 0) {
        await client.del(...keys);
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
      const client = await this.ensureConnected();
      const result = await client.ping();
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
      this.connectionPromise = null;
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
      const client = await this.ensureConnected();
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
      const client = await this.ensureConnected();
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
      const client = await this.ensureConnected();
      if (countArg && limit) {
        return await client.xrange(key, start, end, countArg, limit);
      } else {
        return await client.xrange(key, start, end);
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
      const client = await this.ensureConnected();
      if (countArg && limit) {
        return await client.xrevrange(key, start, end, countArg, limit);
      } else {
        return await client.xrevrange(key, start, end);
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
      const client = await this.ensureConnected();
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
      const client = await this.ensureConnected();
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
      const client = await this.ensureConnected();
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
   * Atomically set a key only if it does not already exist (SET NX).
   * Returns true when the key was set, false when it already existed.
   * When a TTL is provided, the key auto-expires after that many seconds (EX).
   */
  async setnx(
    key: string,
    value: string,
    ttlSeconds?: number
  ): Promise<boolean> {
    try {
      const client = await this.ensureConnected();
      const result =
        ttlSeconds !== undefined
          ? await client.set(key, value, "EX", ttlSeconds, "NX")
          : await client.set(key, value, "NX");
      return result === "OK";
    } catch (error) {
      console.error(
        { service: "redis", key, err: error },
        "Redis SETNX failed"
      );
      throw error;
    }
  }

  /**
   * Get stream info
   */
  async xinfo(subcommand: "STREAM", key: string): Promise<any> {
    try {
      const client = await this.ensureConnected();
      return await client.xinfo(subcommand, key);
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
