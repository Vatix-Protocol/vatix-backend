import { createHash } from "crypto";
import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import { redis } from "../../../../src/services/redis.js";
import type {
  AuditArchiverJobResult,
  ArchivedEventResult,
} from "./types.js";

export interface AuditArchiverJobConfig {
  maxRunMs?: number;
  batchSize?: number;
}

/**
 * Audit archiver job: drains unarchived Redis stream entries and archives to
 * Postgres before allowing MAXLEN trim. Prevents trade data loss during disputes.
 */
export class AuditArchiverJob {
  private readonly maxRunMs: number;
  private readonly batchSize: number;
  private readonly hashAlgorithm = "sha256";
  private readonly keyPrefix: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: ILogger,
    config: AuditArchiverJobConfig
  ) {
    this.maxRunMs = config.maxRunMs ?? 0;
    this.batchSize = config.batchSize ?? 1000;
    this.keyPrefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
  }

  async run(): Promise<AuditArchiverJobResult> {
    const startedAt = new Date();
    const now = new Date();

    this.logger.info("Audit archiver job started");

    try {
      // Get all markets that have unarchived entries
      const markets = await this.getMarketsWithUnarchived();
      this.logger.info("Found markets with unarchived entries", {
        count: markets.length,
      });

      const results: ArchivedEventResult[] = [];

      for (const market of markets) {
        if (this.maxRunMs > 0 && Date.now() - startedAt.getTime() >= this.maxRunMs) {
          this.logger.warn("Audit archiver exceeded maxRunMs, stopping early", {
            maxRunMs: this.maxRunMs,
            processedSoFar: results.length,
            remainingMarkets: markets.length - results.indexOf(market),
          });
          break;
        }

        const marketResults = await this.archiveMarket(market);
        results.push(...marketResults);
      }

      const completedAt = new Date();
      const archivedCount = results.filter((r) => r.status === "archived").length;
      const erroredCount = results.filter((r) => r.status === "error").length;
      const skippedCount = results.filter((r) => r.status === "skipped").length;

      // Calculate archive lag (time since oldest unarchived entry)
      const archiveLagMs = await this.calculateArchiveLag();

      this.logger.info("Audit archiver job completed", {
        totalEvents: results.length,
        archivedCount,
        erroredCount,
        skippedCount,
        archiveLagMs,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      });

      return {
        totalEvents: results.length,
        archivedCount,
        erroredCount,
        skippedCount,
        events: results,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        archiveLagMs,
      };
    } catch (error) {
      this.logger.error("Audit archiver job failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      const completedAt = new Date();
      return {
        totalEvents: 0,
        archivedCount: 0,
        erroredCount: 0,
        skippedCount: 0,
        events: [],
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
      };
    }
  }

  /**
   * Get all markets that have unarchived stream entries.
   */
  private async getMarketsWithUnarchived(): Promise<string[]> {
    const markets = await this.prisma.market.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    return markets.map((m) => m.id);
  }

  /**
   * Archive all unarchived entries for a market.
   */
  private async archiveMarket(marketId: string): Promise<ArchivedEventResult[]> {
    const streamKey = `${this.keyPrefix}audit:market:${marketId}`;
    const results: ArchivedEventResult[] = [];

    try {
      // Get watermark for this market
      const watermark = await this.prisma.tradeStreamWatermark.findUnique({
        where: { marketId },
      });

      // Query all entries after the watermark
      let cursor = watermark?.marketStreamId ?? "-";

      while (true) {
        const entries = await redis.xrange(
          streamKey,
          `(${cursor}`,
          "+",
          "COUNT",
          this.batchSize.toString()
        );

        if (entries.length === 0) break;

        for (const [streamId, fields] of entries) {
          const parseResult = this.parseStreamFields(fields);
          if (!parseResult) {
            results.push({
              marketId,
              streamId,
              status: "skipped",
            });
            continue;
          }

          try {
            const payload = JSON.stringify(parseResult.logData);
            const prevHash = await this.getPrevHash(marketId);
            const entryHash = this.computeHash(payload, prevHash);

            // Archive to Postgres (upsert)
            await this.prisma.tradeAuditEvent.upsert({
              where: { streamId },
              create: {
                tradeId: parseResult.logData.tradeId,
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

            results.push({
              marketId,
              streamId,
              status: "archived",
            });

            cursor = streamId;
          } catch (error) {
            this.logger.error("Failed to archive event", {
              marketId,
              streamId,
              error: error instanceof Error ? error.message : String(error),
            });
            results.push({
              marketId,
              streamId,
              status: "error",
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Update watermark after batch
        if (cursor !== watermark?.marketStreamId) {
          await this.prisma.tradeStreamWatermark.upsert({
            where: { marketId },
            create: {
              marketId,
              globalStreamId: cursor,
              marketStreamId: cursor,
              archiveInitiatedAt: new Date(),
            },
            update: {
              marketStreamId: cursor,
              lastArchivedAt: new Date(),
            },
          });
        }

        if (entries.length < this.batchSize) break;
      }
    } catch (error) {
      this.logger.error("Archive market failed", {
        marketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return results;
  }

  /**
   * Parse Redis stream fields into log data.
   */
  private parseStreamFields(
    fields: string[]
  ): { logData: Record<string, string> } | null {
    const logData: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      logData[fields[i]] = fields[i + 1];
    }
    return Object.keys(logData).length > 0 ? { logData } : null;
  }

  /**
   * Get the previous hash for hash-chaining.
   */
  private async getPrevHash(marketId: string): Promise<string> {
    const lastEvent = await this.prisma.tradeAuditEvent.findFirst({
      where: { marketId },
      orderBy: { archivedAt: "desc" },
      select: { entryHash: true },
    });
    return lastEvent?.entryHash ?? "0";
  }

  /**
   * Compute SHA256 hash of payload + previous hash.
   */
  private computeHash(payload: string, prevHash: string): string {
    const combined = `${payload}${prevHash}`;
    return createHash(this.hashAlgorithm).update(combined).digest("hex");
  }

  /**
   * Calculate archive lag: time since oldest unarchived entry in any market.
   */
  private async calculateArchiveLag(): Promise<number | undefined> {
    try {
      const keyPrefix = this.keyPrefix;
      const globalStream = `${keyPrefix}audit:trades:global`;

      const info = await redis.xinfo("STREAM", globalStream);

      const infoObj: Record<string, any> = {};
      for (let i = 0; i < info.length; i += 2) {
        infoObj[info[i] as string] = info[i + 1];
      }

      const lastEntry = infoObj["last-entry"];
      if (!lastEntry || !lastEntry[0]) {
        return undefined;
      }

      // Parse stream ID (timestamp-sequence) to get approximate time
      const [timestampStr] = String(lastEntry[0]).split("-");
      const timestamp = parseInt(timestampStr, 10);

      if (!Number.isFinite(timestamp)) {
        return undefined;
      }

      return Date.now() - timestamp;
    } catch (error) {
      this.logger.warn("Failed to calculate archive lag", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}
