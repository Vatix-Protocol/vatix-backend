import { createHash } from "crypto";
import { redis } from "./redis.js";
import { getPrismaClient } from "./prisma.js";
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
  private readonly streamPrefix: string;
  private readonly globalStream: string;
  private readonly maxLogEntries = 100000; // ~30 days at 1 trade/min
  private readonly approximateTrimming = true;
  private readonly hashAlgorithm = "sha256";

  constructor() {
    const keyPrefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
    this.streamPrefix = `${keyPrefix}audit:market:`;
    this.globalStream = `${keyPrefix}audit:trades:global`;
  }

  /**
   * Log a trade execution to audit stream with hash-chaining and async archival.
   * Creates two entries: one in market-specific stream, one in global stream.
   * Computes SHA256 hash and triggers async archive to Postgres before trim.
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

      const baseStreamId = `${trade.timestamp}`;
      const marketStream = this.getMarketStream(trade.marketId);
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

        // Trigger async archive (non-blocking)
        if (marketEntryId) {
          this.archiveAuditEventAsync(
            trade.id,
            trade.marketId,
            logData,
            marketEntryId
          ).catch((err) => {
            console.error("Failed to archive audit event:", err);
          });
        }

        const duration = performance.now() - startTime;

        if (duration > 5) {
          console.warn(
            `Audit log write took ${duration.toFixed(2)}ms (target: <5ms)`
          );
        }

        return marketEntryId;
      } catch (err: any) {
        if (
          err.message?.includes("equal or smaller") ||
          err.message?.includes("ID")
        ) {
          console.warn(
            `Stream ID conflict for ${streamId}, using auto-generated ID`
          );

          const marketEntryId = await redis.xadd(
            marketStream,
            "MAXLEN",
            this.approximateTrimming ? "~" : "",
            this.maxLogEntries,
            "*",
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

          if (marketEntryId) {
            this.archiveAuditEventAsync(
              trade.id,
              trade.marketId,
              logData,
              marketEntryId
            ).catch((err) => {
              console.error("Failed to archive audit event:", err);
            });
          }

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
   * Get paginated trade history for a wallet address from Postgres (durable).
   * Redis audit stream is still written asynchronously for real-time consumers.
   */
  async getWalletTradeHistory(
    wallet: string,
    page: number = 1,
    limit: number = 20,
    fromMs?: number,
    toMs?: number,
    marketId?: string
  ): Promise<{
    trades: AuditLogEntry[];
    total: number;
    hasNext: boolean;
    page: number;
    limit: number;
  }> {
    const prisma = getPrismaClient();

    const where = {
      OR: [{ buyerAddress: wallet }, { sellerAddress: wallet }],
      ...(marketId ? { marketId } : {}),
      ...(fromMs !== undefined || toMs !== undefined
        ? {
            tradedAt: {
              ...(fromMs !== undefined ? { gte: new Date(fromMs) } : {}),
              ...(toMs !== undefined ? { lte: new Date(toMs) } : {}),
            },
          }
        : {}),
    };

    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      prisma.trade.findMany({
        where,
        orderBy: { tradedAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.trade.count({ where }),
    ]);

    const trades: AuditLogEntry[] = rows.map((row) => ({
      id: row.id,
      trade: {
        id: row.tradeId,
        marketId: row.marketId,
        outcome: row.outcome as "YES" | "NO",
        buyerAddress: row.buyerAddress,
        sellerAddress: row.sellerAddress,
        buyOrderId: row.buyOrderId,
        sellOrderId: row.sellOrderId,
        price: Number(row.price),
        quantity: row.quantity,
        timestamp: row.tradedAt.getTime(),
      },
      loggedAt: row.createdAt.toISOString(),
    }));

    return {
      trades,
      total,
      hasNext: skip + rows.length < total,
      page,
      limit,
    };
  }

  /**
   * Get paginated trade history across all wallets from Postgres (durable).
   * Same shape as getWalletTradeHistory but without a buyer/seller filter.
   */
  async getTradeHistory(
    page: number = 1,
    limit: number = 20,
    fromMs?: number,
    toMs?: number,
    marketId?: string
  ): Promise<{
    trades: AuditLogEntry[];
    total: number;
    hasNext: boolean;
    page: number;
    limit: number;
  }> {
    const prisma = getPrismaClient();

    const where = {
      ...(marketId ? { marketId } : {}),
      ...(fromMs !== undefined || toMs !== undefined
        ? {
            tradedAt: {
              ...(fromMs !== undefined ? { gte: new Date(fromMs) } : {}),
              ...(toMs !== undefined ? { lte: new Date(toMs) } : {}),
            },
          }
        : {}),
    };

    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      prisma.trade.findMany({
        where,
        orderBy: { tradedAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.trade.count({ where }),
    ]);

    const trades: AuditLogEntry[] = rows.map((row) => ({
      id: row.id,
      trade: {
        id: row.tradeId,
        marketId: row.marketId,
        outcome: row.outcome as "YES" | "NO",
        buyerAddress: row.buyerAddress,
        sellerAddress: row.sellerAddress,
        buyOrderId: row.buyOrderId,
        sellOrderId: row.sellOrderId,
        price: Number(row.price),
        quantity: row.quantity,
        timestamp: row.tradedAt.getTime(),
      },
      loggedAt: row.createdAt.toISOString(),
    }));

    return {
      trades,
      total,
      hasNext: skip + rows.length < total,
      page,
      limit,
    };
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

  /**
   * Compute SHA256 hash of payload + previous hash for chain verification
   */
  private computeHash(payload: string, prevHash: string): string {
    const combined = `${payload}${prevHash}`;
    return createHash(this.hashAlgorithm).update(combined).digest("hex");
  }

  /**
   * Get the previous hash for hash-chaining. Looks up the most recent archived
   * entry for the market. Returns "0" (root) if no previous entry exists.
   */
  private async getPrevHash(marketId: string): Promise<string> {
    const prisma = getPrismaClient();
    const lastEvent = await prisma.tradeAuditEvent.findFirst({
      where: { marketId },
      orderBy: { archivedAt: "desc" },
      select: { entryHash: true },
    });
    return lastEvent?.entryHash ?? "0";
  }

  /**
   * Archive an audit event to Postgres asynchronously.
   * Computes hash, stores with prevHash, and updates watermark.
   * Non-blocking; errors are logged but don't affect request path.
   */
  private async archiveAuditEventAsync(
    tradeId: string,
    marketId: string,
    logData: Record<string, string>,
    streamId: string
  ): Promise<void> {
    try {
      const prisma = getPrismaClient();
      const payload = JSON.stringify(logData);
      const prevHash = await this.getPrevHash(marketId);
      const entryHash = this.computeHash(payload, prevHash);

      // Archive the event (upsert to handle potential duplicates from retries)
      await prisma.tradeAuditEvent.upsert({
        where: { streamId },
        create: {
          tradeId,
          marketId,
          payload,
          prevHash,
          entryHash,
          streamId,
        },
        update: {
          archivedAt: new Date(),
        },
      });

      // Update watermark
      await prisma.tradeStreamWatermark.upsert({
        where: { marketId },
        create: {
          marketId,
          globalStreamId: streamId,
          marketStreamId: streamId,
          archiveInitiatedAt: new Date(),
        },
        update: {
          marketStreamId: streamId,
          lastArchivedAt: new Date(),
        },
      });
    } catch (error) {
      console.error("Archive async failed:", error);
      throw error;
    }
  }

  /**
   * Verify hash chain integrity for a market within a time range.
   * Detects tampering of intermediate records.
   */
  async verifyAuditChain(
    marketId: string,
    startTime?: Date,
    endTime?: Date
  ): Promise<{
    valid: boolean;
    totalEvents: number;
    mismatchCount: number;
    errors: Array<{ streamId: string; reason: string }>;
  }> {
    const prisma = getPrismaClient();

    const where: any = { marketId };
    if (startTime || endTime) {
      where.archivedAt = {};
      if (startTime) where.archivedAt.gte = startTime;
      if (endTime) where.archivedAt.lte = endTime;
    }

    const events = await prisma.tradeAuditEvent.findMany({
      where,
      orderBy: { archivedAt: "asc" },
    });

    const errors: Array<{ streamId: string; reason: string }> = [];
    let prevHash = "0";

    for (const event of events) {
      const expectedHash = this.computeHash(event.payload, event.prevHash);
      if (expectedHash !== event.entryHash) {
        errors.push({
          streamId: event.streamId,
          reason: `Hash mismatch: expected ${expectedHash}, got ${event.entryHash}`,
        });
      }
      prevHash = event.entryHash;
    }

    return {
      valid: errors.length === 0,
      totalEvents: events.length,
      mismatchCount: errors.length,
      errors,
    };
  }
}

// Export singleton instance
export const auditService = new AuditService();
