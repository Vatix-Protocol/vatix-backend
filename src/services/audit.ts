import { redis } from "./redis.js";
import type { Trade } from "../matching/engine.js";

/**
 * Audit log entry for a trade execution
 */
export interface AuditLogEntry {
  /** Unique sequential ID from Redis Stream */
  id: string;
  /** Trade details */
  trade: Trade;
  /** ISO timestamp when logged */
  loggedAt: string;
}

/**
 * Audit service for immutable trade logging using Redis Streams
 *
 * Redis Streams provide:
 * - Append-only semantics (immutable logs)
 * - Sequential IDs (automatic ordering)
 * - Efficient range queries
 * - Automatic expiration (MAXLEN)
 */
export class AuditService {
  private readonly streamPrefix = "audit:market:";
  private readonly globalStream = "audit:trades:global";
  private readonly maxLogEntries = 100000; // ~30 days at 1 trade/min
  private readonly approximateTrimming = true;

  /**
   * Log a trade execution to audit stream
   * Creates two entries: one in market-specific stream, one in global stream
   *
   * @param trade - Trade to log
   * @returns Stream entry ID
   */
  async logOrderMatch(trade: Trade): Promise<string | null> {
    const startTime = performance.now();

    try {
      const logData = {
        tradeId: trade.id,
        marketId: trade.marketId,
        outcome: trade.outcome,
        buyerAddress: trade.buyerAddress,
        sellerAddress: trade.sellerAddress,
        buyOrderId: trade.buyOrderId,
        sellOrderId: trade.sellOrderId,
        price: trade.price.toString(),
        quantity: trade.quantity.toString(),
        timestamp: trade.timestamp.toString(),
        loggedAt: new Date().toISOString(),
      };

      // Use trade timestamp, but let Redis auto-increment sequence if there's a collision
      // If timestamp-0 exists, Redis will use timestamp-1, timestamp-2, etc.
      const baseStreamId = `${trade.timestamp}`;

      // Log to market-specific stream
      const marketStream = this.getMarketStream(trade.marketId);

      // Try with -0 first, Redis will auto-increment if needed
      let streamId = `${baseStreamId}-0`;

      try {
        const marketEntryId = await redis.xadd(
          marketStream,
          "MAXLEN",
          this.approximateTrimming ? "~" : "",
          this.maxLogEntries,
          streamId,
          ...this.flattenObject(logData)
        );

        // Use same ID for global stream
        await redis.xadd(
          this.globalStream,
          "MAXLEN",
          this.approximateTrimming ? "~" : "",
          this.maxLogEntries * 10,
          streamId,
          ...this.flattenObject(logData)
        );

        const duration = performance.now() - startTime;

        if (duration > 5) {
          console.warn(
            `Audit log write took ${duration.toFixed(2)}ms (target: <5ms)`
          );
        }

        return marketEntryId;
      } catch (err: any) {
        // If Stream ID already exists or is too old, let Redis auto-generate
        if (
          err.message?.includes("equal or smaller") ||
          err.message?.includes("ID")
        ) {
          console.warn(
            `Stream ID conflict for ${streamId}, using auto-generated ID`
          );

          // Fall back to auto-generated ID
          const marketEntryId = await redis.xadd(
            marketStream,
            "MAXLEN",
            this.approximateTrimming ? "~" : "",
            this.maxLogEntries,
            "*", // Auto-generate
            ...this.flattenObject(logData)
          );

          await redis.xadd(
            this.globalStream,
            "MAXLEN",
            this.approximateTrimming ? "~" : "",
            this.maxLogEntries * 10,
            "*",
            ...this.flattenObject(logData)
          );

          return marketEntryId;
        }
        throw err;
      }
    } catch (error) {
      console.error("Failed to log trade to audit stream:", error);
      throw error;
    }
  }

  /**
   * Get audit log entries for a specific market
   * Returns entries in chronological order (oldest first)
   *
   * @param marketId - Market ID to query
   * @param limit - Maximum number of entries (default: 100)
   * @returns Array of audit log entries
   */
  async getAuditLog(
    marketId: string,
    limit: number = 100
  ): Promise<AuditLogEntry[]> {
    const stream = this.getMarketStream(marketId);

    try {
      const entries = await redis.xrange(
        stream,
        "-",
        "+",
        "COUNT",
        limit.toString()
      );

      return entries.map(([id, fields]) => this.parseStreamEntry(id, fields));
    } catch (error) {
      console.error(
        `Failed to retrieve audit log for market ${marketId}:`,
        error
      );
      return [];
    }
  }

  /**
   * Get recent trades across all markets
   * Useful for global monitoring and analytics
   *
   * @param limit - Maximum number of entries (default: 100)
   * @returns Array of audit log entries
   */
  async getRecentTrades(limit: number = 100): Promise<AuditLogEntry[]> {
    try {
      const entries = await redis.xrevrange(
        this.globalStream,
        "+",
        "-",
        "COUNT",
        limit.toString()
      );

      return entries.map(([id, fields]) => this.parseStreamEntry(id, fields));
    } catch (error) {
      console.error("Failed to retrieve recent trades:", error);
      return [];
    }
  }

  /**
   * Get audit log entries within a time range
   *
   * @param marketId - Market ID to query
   * @param startTime - Start timestamp (Unix milliseconds)
   * @param endTime - End timestamp (Unix milliseconds)
   * @returns Array of audit log entries
   */
  async getAuditLogRange(
    marketId: string,
    startTime: number,
    endTime: number
  ): Promise<AuditLogEntry[]> {
    const stream = this.getMarketStream(marketId);

    try {
      const startId = `${startTime}-0`;
      const endId = `${endTime}-${Number.MAX_SAFE_INTEGER}`;

      // No COUNT argument here
      const entries = await redis.xrange(stream, startId, endId);

      return entries.map(([id, fields]) => this.parseStreamEntry(id, fields));
    } catch (error) {
      console.error(
        `Failed to retrieve audit log range for market ${marketId}:`,
        error
      );
      return [];
    }
  }

  /**
   * Get audit log statistics for a market
   *
   * @param marketId - Market ID to query
   * @returns Statistics about the audit log
   */
  async getAuditLogStats(marketId: string): Promise<{
    totalEntries: number;
    oldestEntry: string | null;
    newestEntry: string | null;
  }> {
    const stream = this.getMarketStream(marketId);

    try {
      const info = await redis.xinfo("STREAM", stream);

      // Redis returns array of [key, value, key, value, ...]
      // Convert to object for easier access
      const infoObj: Record<string, any> = {};
      for (let i = 0; i < info.length; i += 2) {
        infoObj[info[i] as string] = info[i + 1];
      }

      // Extract values
      const length = infoObj["length"] || 0;
      const firstEntry = infoObj["first-entry"];
      const lastEntry = infoObj["last-entry"];

      return {
        totalEntries: length,
        oldestEntry: firstEntry ? firstEntry[0] : null,
        newestEntry: lastEntry ? lastEntry[0] : null,
      };
    } catch (error) {
      // Stream doesn't exist yet
      return {
        totalEntries: 0,
        oldestEntry: null,
        newestEntry: null,
      };
    }
  }

  /**
   * Helper: Get market-specific stream name
   */
  private getMarketStream(marketId: string): string {
    return `${this.streamPrefix}${marketId}`;
  }

  /**
   * Helper: Flatten object into array for Redis XADD
   * XADD requires: key1, value1, key2, value2, ...
   */
  private flattenObject(obj: Record<string, string>): string[] {
    const result: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      result.push(key, value);
    }
    return result;
  }

  /**
   * Helper: Parse Redis Stream entry into AuditLogEntry
   */
  private parseStreamEntry(id: string, fields: string[]): AuditLogEntry {
    // Fields are returned as flat array: [key1, value1, key2, value2, ...]
    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      data[fields[i]] = fields[i + 1];
    }

    const trade: Trade = {
      id: data.tradeId,
      marketId: data.marketId,
      outcome: data.outcome as "YES" | "NO",
      buyerAddress: data.buyerAddress,
      sellerAddress: data.sellerAddress,
      buyOrderId: data.buyOrderId,
      sellOrderId: data.sellOrderId,
      price: parseFloat(data.price),
      quantity: parseInt(data.quantity, 10),
      timestamp: parseInt(data.timestamp, 10),
    };

    return {
      id,
      trade,
      loggedAt: data.loggedAt,
    };
  }
}

// Export singleton instance
export const auditService = new AuditService();
