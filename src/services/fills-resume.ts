import { redis } from "./redis.js";
import { getPrismaClient } from "./prisma.js";

/**
 * Fills SSE resume cursor: opaque string representing a point in the trade stream
 * Format: Redis stream ID (e.g., "1234567890-0")
 */
export type FillsResumeCursor = string;

export interface ResumeState {
  cursor: FillsResumeCursor;
  tradeId?: string;
  tradedAt: Date;
}

export interface GapDetectionResult {
  hasGap: boolean;
  reason?: "cursor_trimmed" | "cursor_unknown" | "beyond_max_window";
  suggestedCursor?: FillsResumeCursor;
}

export interface ReplayBounds {
  minCursor: FillsResumeCursor | null;
  maxCursor: FillsResumeCursor | null;
  recordCount: number;
}

export class FillsResumeService {
  private readonly keyPrefix: string;
  private readonly globalStream: string;
  private readonly maxReplayWindowMs: number;

  constructor() {
    this.keyPrefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
    this.globalStream = `${this.keyPrefix}audit:trades:global`;
    // Max 10 minutes of replay buffer; beyond that, client must do REST poll
    this.maxReplayWindowMs =
      parseInt(process.env.FILLS_MAX_REPLAY_WINDOW_MS ?? "600000", 10) ||
      600000;
  }

  /**
   * Get the earliest available cursor in the audit stream (oldest non-trimmed entry)
   */
  async getOldestAvailableCursor(): Promise<FillsResumeCursor | null> {
    try {
      const entries = await redis.xrange(
        this.globalStream,
        "-",
        "+",
        "COUNT",
        "1"
      );
      return entries.length > 0 ? (entries[0][0] as FillsResumeCursor) : null;
    } catch (error) {
      console.error("Failed to get oldest available cursor:", error);
      return null;
    }
  }

  /**
   * Get the latest cursor in the audit stream (newest entry)
   */
  async getLatestAvailableCursor(): Promise<FillsResumeCursor | null> {
    try {
      const entries = await redis.xrevrange(
        this.globalStream,
        "+",
        "-",
        "COUNT",
        "1"
      );
      return entries.length > 0 ? (entries[0][0] as FillsResumeCursor) : null;
    } catch (error) {
      console.error("Failed to get latest available cursor:", error);
      return null;
    }
  }

  /**
   * Detect if a cursor is stale, trimmed, or out of bounds
   * Returns gap info and suggested recovery cursor.
   * A gap is only declared if the cursor cannot be backfilled from Postgres.
   */
  async detectGap(cursor: FillsResumeCursor): Promise<GapDetectionResult> {
    try {
      const prisma = getPrismaClient();

      // Check if cursor exists in Redis stream
      const entries = await redis.xrange(
        this.globalStream,
        cursor,
        cursor,
        "COUNT",
        "1"
      );

      if (entries.length === 0) {
        // Cursor not in Redis: check if it can be backfilled from Postgres
        const cursorMs = this.extractTimestampMs(cursor);
        const cursorDate = new Date(cursorMs);

        // Query Postgres to see if we have any trades at or after this cursor
        const oldestPostgresEntry = await prisma.trade.findFirst({
          where: {
            tradedAt: { gte: cursorDate },
          },
          select: { tradedAt: true },
          orderBy: { tradedAt: "asc" },
        });

        if (oldestPostgresEntry) {
          // Postgres has data we can backfill — no gap
          return { hasGap: false };
        }

        // Neither Redis nor Postgres has data for this cursor
        const oldest = await this.getOldestAvailableCursor();
        const latestPostgres = await prisma.trade.findFirst({
          select: { tradedAt: true },
          orderBy: { tradedAt: "desc" },
        });

        const latestCursor = latestPostgres
          ? `${latestPostgres.tradedAt.getTime()}-0`
          : oldest;

        if (!oldest && !latestPostgres) {
          // Empty everywhere: allow client to continue from cursor
          return { hasGap: false };
        }

        // Check if cursor is before oldest Redis entry
        if (oldest) {
          const oldestMs = this.extractTimestampMs(oldest);
          if (cursorMs < oldestMs) {
            // Cursor was trimmed from Redis but check if Postgres has it
            // (already checked above, Postgres doesn't have it either)
            return {
              hasGap: true,
              reason: "cursor_trimmed",
              suggestedCursor: oldest,
            };
          }
        }

        // Cursor is unknown (never existed anywhere)
        return {
          hasGap: true,
          reason: "cursor_unknown",
          suggestedCursor: oldest || latestCursor,
        };
      }

      // Cursor exists in Redis; no gap
      return { hasGap: false };
    } catch (error) {
      console.error("Failed to detect gap:", error);
      // Fail open on errors: prefer reconnecting over 410 storms
      return { hasGap: false };
    }
  }

  /**
   * Get trades for a wallet after a given cursor (inclusive of cursor)
   * Returns the fills and the last cursor position
   */
  async getTradesAfterCursor(
    wallet: string,
    cursor: FillsResumeCursor,
    limit: number = 100
  ): Promise<{
    trades: Array<{
      tradeId: string;
      marketId: string;
      outcome: string;
      side: "BUY" | "SELL";
      orderId: string;
      counterpartyAddress: string;
      price: number;
      quantity: number;
      tradedAt: Date;
      streamId: FillsResumeCursor;
    }>;
    lastCursor: FillsResumeCursor | null;
  }> {
    try {
      const prisma = getPrismaClient();

      // Extract timestamp from cursor to query database
      const cursorMs = this.extractTimestampMs(cursor);
      const cursorDate = new Date(cursorMs);

      // Query trades after cursor
      const trades = await prisma.trade.findMany({
        where: {
          tradedAt: { gte: cursorDate },
          OR: [{ buyerAddress: wallet }, { sellerAddress: wallet }],
        },
        orderBy: { tradedAt: "asc" },
        take: limit,
      });

      if (trades.length === 0) {
        return { trades: [], lastCursor: cursor };
      }

      // Enrich with stream IDs (for now, use tradedAt as cursor since audit stream
      // uses millisecond-precision timestamps)
      const enriched = trades.map((trade) => ({
        tradeId: trade.tradeId,
        marketId: trade.marketId,
        outcome: trade.outcome,
        side:
          trade.buyerAddress === wallet ? ("BUY" as const) : ("SELL" as const),
        orderId:
          trade.buyerAddress === wallet ? trade.buyOrderId : trade.sellOrderId,
        counterpartyAddress:
          trade.buyerAddress === wallet
            ? trade.sellerAddress
            : trade.buyerAddress,
        price: Number(trade.price),
        quantity: trade.quantity,
        tradedAt: trade.tradedAt,
        streamId: `${trade.tradedAt.getTime()}-0` as FillsResumeCursor,
      }));

      const lastTrade = enriched[enriched.length - 1];
      return {
        trades: enriched,
        lastCursor: lastTrade.streamId,
      };
    } catch (error) {
      console.error("Failed to get trades after cursor:", error);
      return { trades: [], lastCursor: cursor };
    }
  }

  /**
   * Get replay bounds for a wallet (oldest and newest available trades)
   */
  async getReplayBounds(wallet: string): Promise<ReplayBounds> {
    try {
      const prisma = getPrismaClient();

      const [first, last, count] = await Promise.all([
        prisma.trade.findFirst({
          where: {
            OR: [{ buyerAddress: wallet }, { sellerAddress: wallet }],
          },
          select: { tradedAt: true },
          orderBy: { tradedAt: "asc" },
        }),
        prisma.trade.findFirst({
          where: {
            OR: [{ buyerAddress: wallet }, { sellerAddress: wallet }],
          },
          select: { tradedAt: true },
          orderBy: { tradedAt: "desc" },
        }),
        prisma.trade.count({
          where: {
            OR: [{ buyerAddress: wallet }, { sellerAddress: wallet }],
          },
        }),
      ]);

      return {
        minCursor: first ? `${first.tradedAt.getTime()}-0` : null,
        maxCursor: last ? `${last.tradedAt.getTime()}-0` : null,
        recordCount: count,
      };
    } catch (error) {
      console.error("Failed to get replay bounds:", error);
      return { minCursor: null, maxCursor: null, recordCount: 0 };
    }
  }

  /**
   * Extract millisecond timestamp from cursor (Redis stream ID format: ms-seq)
   */
  private extractTimestampMs(cursor: FillsResumeCursor): number {
    const [ms] = cursor.split("-");
    const timestamp = parseInt(ms, 10);
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  /**
   * Parse a resume cursor (which may be ISO timestamp for backwards compatibility)
   */
  parseCursor(raw: string | undefined): FillsResumeCursor | null {
    if (!raw) return null;

    // If it looks like a timestamp (numeric), use as-is
    if (/^\d+$/.test(raw)) {
      return raw as FillsResumeCursor;
    }

    // If it looks like stream ID format (ms-seq), use as-is
    if (/^\d+-\d+$/.test(raw)) {
      return raw as FillsResumeCursor;
    }

    // Try to parse as ISO date and convert to stream ID format
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return `${parsed.getTime()}-0` as FillsResumeCursor;
    }

    return null;
  }
}

export const fillsResumeService = new FillsResumeService();
