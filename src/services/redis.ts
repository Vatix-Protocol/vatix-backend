import Redis from 'ioredis';

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

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not set');
    }

    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: MAX_RETRIES,
      retryStrategy: (times: number) => {
        if (times > MAX_RETRIES) {
          console.error(`Redis: Max retries (${MAX_RETRIES}) exceeded`);
          return null; // stop retrying
        }
        const delay = Math.min(BASE_RETRY_DELAY * Math.pow(2, times - 1), 2000);
        console.log(`Redis: Retry attempt ${times}, waiting ${delay}ms`);
        return delay;
      },
      lazyConnect: false,
    });

    this.client.on('connect', () => {
      console.log('Redis: Connected');
      this.retryCount = 0;
    });

    this.client.on('error', (err: Error) => {
      console.error('Redis: Connection error:', err.message);
    });

    this.client.on('reconnecting', () => {
      this.retryCount++;
      console.log(`Redis: Reconnecting (attempt ${this.retryCount})`);
    });

    this.client.on('close', () => {
      console.log('Redis: Connection closed');
    });

    this.isConnecting = false;
  }

  // ==================== Basic Methods ====================

  /**
   * Get a value by key
   */
  async get(key: string): Promise<string | null> {
    try {
      return await this.getClient().get(key);
    } catch (error) {
      console.error('Redis get error:', error);
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
        await this.getClient().set(key, value, 'EX', ttl);
      } else {
        await this.getClient().set(key, value);
      }
    } catch (error) {
      console.error('Redis set error:', error);
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
      console.error('Redis del error:', error);
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
      console.error('Redis exists error:', error);
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
      console.error('Redis setOrderBook error:', error);
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
      console.error('Redis getOrderBook error:', error);
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
      console.error('Redis clearOrderBook error:', error);
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
      return result === 'PONG';
    } catch (error) {
      console.error('Redis health check failed:', error);
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
      console.log('Redis: Disconnected gracefully');
    }
  }
}

/**
 * Singleton instance of RedisService
 */
export const redis = new RedisService();

export { RedisService };
