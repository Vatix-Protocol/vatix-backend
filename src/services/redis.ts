import Redis from "ioredis";

const ORDER_BOOK_TTL = 60; // seconds
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 100; // ms

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

      this.client = new Redis(redisUrl, {
        maxRetriesPerRequest: MAX_RETRIES,
        retryStrategy: (times: number) => {
          if (times > MAX_RETRIES) {
            console.error(
              { service: "redis", maxRetries: MAX_RETRIES },
              "Redis max retries exceeded, giving up"
            );
            return null; // stop retrying
          }
          const delay = Math.min(
            BASE_RETRY_DELAY * Math.pow(2, times - 1),
            2000
          );
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
    return `orderbook:${marketId}:${outcome}`;
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
   * Clear all order books for a market (matches pattern orderbook:{marketId}:*)
   */
  async clearOrderBook(marketId: string): Promise<void> {
    const pattern = `orderbook:${marketId}:*`;
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
      console.info({ service: "redis" }, "Redis disconnected gracefully");
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
