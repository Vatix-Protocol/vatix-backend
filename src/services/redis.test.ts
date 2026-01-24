import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { redis, RedisService, OrderBookData } from './redis';

describe('RedisService', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(async () => {
        await redis.disconnect();
        vi.restoreAllMocks();
    });

    describe('singleton instance', () => {
        it('should export a singleton redis instance', () => {
            expect(redis).toBeDefined();
            expect(redis).toBeInstanceOf(RedisService);
        });
    });

    describe('healthCheck', () => {
        it('should return true for working Redis connection', async () => {
            const isHealthy = await redis.healthCheck();
            expect(isHealthy).toBe(true);
        });
    });

    describe('basic operations', () => {
        const testKey = 'test:basic:key';
        const testValue = 'test-value';

        afterEach(async () => {
            await redis.del(testKey);
        });

        it('should set and get a value', async () => {
            await redis.set(testKey, testValue);
            const result = await redis.get(testKey);
            expect(result).toBe(testValue);
        });

        it('should return null for non-existent key', async () => {
            const result = await redis.get('non:existent:key');
            expect(result).toBeNull();
        });

        it('should delete a key', async () => {
            await redis.set(testKey, testValue);
            await redis.del(testKey);
            const result = await redis.get(testKey);
            expect(result).toBeNull();
        });

        it('should check if key exists', async () => {
            const existsBefore = await redis.exists(testKey);
            expect(existsBefore).toBe(false);

            await redis.set(testKey, testValue);
            const existsAfter = await redis.exists(testKey);
            expect(existsAfter).toBe(true);
        });
    });

    describe('TTL expiration', () => {
        const testKey = 'test:ttl:key';

        afterEach(async () => {
            await redis.del(testKey);
        });

        it('should expire key after TTL', async () => {
            await redis.set(testKey, 'expires-soon', 1); // 1 second TTL

            const existsImmediately = await redis.exists(testKey);
            expect(existsImmediately).toBe(true);

            // Wait for expiration
            await new Promise((resolve) => setTimeout(resolve, 1100));

            const existsAfter = await redis.exists(testKey);
            expect(existsAfter).toBe(false);
        });
    });

    describe('order book operations', () => {
        const marketId = 'market-123';
        const outcome = 'yes';
        const orderBookData: OrderBookData = {
            bids: [
                { price: 0.45, quantity: 100 },
                { price: 0.44, quantity: 200 },
            ],
            asks: [
                { price: 0.46, quantity: 150 },
                { price: 0.47, quantity: 250 },
            ],
            timestamp: Date.now(),
        };

        afterEach(async () => {
            await redis.clearOrderBook(marketId);
        });

        it('should store and retrieve order book', async () => {
            await redis.setOrderBook(marketId, outcome, orderBookData);
            const result = await redis.getOrderBook(marketId, outcome);

            expect(result).toBeDefined();
            expect(result?.bids).toEqual(orderBookData.bids);
            expect(result?.asks).toEqual(orderBookData.asks);
        });

        it('should return null for non-existent order book', async () => {
            const result = await redis.getOrderBook('non-existent', 'no');
            expect(result).toBeNull();
        });

        it('should clear all order books for a market', async () => {
            await redis.setOrderBook(marketId, 'yes', orderBookData);
            await redis.setOrderBook(marketId, 'no', orderBookData);

            const yesBefore = await redis.getOrderBook(marketId, 'yes');
            const noBefore = await redis.getOrderBook(marketId, 'no');
            expect(yesBefore).not.toBeNull();
            expect(noBefore).not.toBeNull();

            await redis.clearOrderBook(marketId);

            const yesAfter = await redis.getOrderBook(marketId, 'yes');
            const noAfter = await redis.getOrderBook(marketId, 'no');
            expect(yesAfter).toBeNull();
            expect(noAfter).toBeNull();
        });

        it('should serialize and deserialize order book data correctly', async () => {
            await redis.setOrderBook(marketId, outcome, orderBookData);
            const result = await redis.getOrderBook(marketId, outcome);

            expect(typeof result?.timestamp).toBe('number');
            expect(Array.isArray(result?.bids)).toBe(true);
            expect(Array.isArray(result?.asks)).toBe(true);
            expect(result?.bids[0].price).toBe(0.45);
            expect(result?.bids[0].quantity).toBe(100);
        });
    });

    describe('connection handling', () => {
        it('should handle disconnect gracefully', async () => {
            // First ensure connected
            await redis.healthCheck();

            // Disconnect
            await redis.disconnect();

            // Reconnects on next operation
            const isHealthy = await redis.healthCheck();
            expect(isHealthy).toBe(true);
        });
    });

    describe('error handling', () => {
        it('should return false when REDIS_URL is not set', async () => {
            const originalUrl = process.env.REDIS_URL;
            delete process.env.REDIS_URL;

            const newService = new RedisService();

            // healthCheck catches errors and returns false
            const result = await newService.healthCheck();
            expect(result).toBe(false);

            process.env.REDIS_URL = originalUrl;
        });
    });
});
