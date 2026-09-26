import { createHash } from "crypto";
import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import { redis } from "../../../../src/services/redis.js";
import type {
  AuditArchiverJobResult,
  ArchivedEventResult,
  RetentionResult,
} from "./types.js";
import { planRetentionPurge, type RetentionCandidate } from "./retention.js";

export interface AuditArchiverJobConfig {
  maxRunMs?: number;
  batchSize?: number;
  /**
   * Days of archived audit history to keep. `0` (default) disables retention
   * deletes — the fail-closed default. See `retention.ts`.
   */
  retentionDays?: number;
  /** Max rows a single retention run may delete. */
  retentionBatchSize?: number;
  /** Min rows always kept per market so the chain head stays verifiable. */
  retentionMinPerMarket?: number;
  /**
   * How many archived rows to consider per run when planning a purge. Capped so
   * a large backlog is drained over many polls rather than one huge scan.
   */
  retentionScanLimit?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
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
  private readonly retentionDays: number;
  private readonly retentionBatchSize: number;
  private readonly retentionMinPerMarket: number;
  private readonly retentionScanLimit: number;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: ILogger,
    config: AuditArchiverJobConfig
  ) {
    this.maxRunMs = config.maxRunMs ?? 0;
    this.batchSize = config.batchSize ?? 1000;
    this.keyPrefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
    // Retention defaults to fully disabled — an operator must opt in.
    this.retentionDays = config.retentionDays ?? 0;
    this.retentionBatchSize = config.retentionBatchSize ?? 1000;
    this.retentionMinPerMarket = config.retentionMinPerMarket ?? 1;
    this.retentionScanLimit = config.retentionScanLimit ?? 10_000;
    this.now = config.now ?? (() => new Date());
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
        if (
          this.maxRunMs > 0 &&
          Date.now() - startedAt.getTime() >= this.maxRunMs
        ) {
          this.logger.warn("Audit archiver exceeded maxRunMs, stopping early", {
            maxRunMs: this.maxRunMs,
            processedSoFar: results.length,
            remainingMarkets: markets.length - markets.indexOf(market),
          });
          break;
        }

        const marketResults = await this.archiveMarket(market);
        results.push(...marketResults);
      }

      const completedAt = new Date();
      const archivedCount = results.filter(
        (r) => r.status === "archived"
      ).length;
      const erroredCount = results.filter((r) => r.status === "error").length;
      const skippedCount = results.filter((r) => r.status === "skipped").length;

      // Calculate archive lag (time since oldest unarchived entry)
      const archiveLagMs = await this.calculateArchiveLag();

      // Retention runs after archival so a purge can never race the rows this
      // run just wrote (the window is strictly older, but ordering makes the
      // invariant obvious to reviewers).
      const retention = await this.purgeExpired();

      this.logger.info("Audit archiver job completed", {
        totalEvents: results.length,
        archivedCount,
        erroredCount,
        skippedCount,
        archiveLagMs,
        purgedCount: retention.purgedCount,
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
        retention,
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
  private async archiveMarket(
    marketId: string
  ): Promise<ArchivedEventResult[]> {
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
   * Delete archived audit rows older than the configured retention window.
   *
   * Fail-closed: a disabled policy (`retentionDays <= 0`), a failed candidate
   * scan, or a failed delete all leave the archive untouched and surface an
   * error log rather than throwing. Retention is housekeeping — it must never
   * be able to fail an archival run.
   *
   * The plan itself is computed by the pure `planRetentionPurge`, which
   * guarantees only an oldest *prefix* per market is removed so no retained row
   * is left with a dangling `prevHash` (which would surface as a `chain_gap`
   * in `src/services/auditChain.ts`).
   */
  private async purgeExpired(): Promise<RetentionResult> {
    if (this.retentionDays <= 0) {
      return { purgedCount: 0, disabled: true, marketCount: 0 };
    }

    try {
      const candidates = (await this.prisma.tradeAuditEvent.findMany({
        orderBy: { archivedAt: "asc" },
        take: this.retentionScanLimit,
        select: { id: true, marketId: true, archivedAt: true },
      })) as RetentionCandidate[];

      const plan = planRetentionPurge(candidates, {
        retentionDays: this.retentionDays,
        batchSize: this.retentionBatchSize,
        minRetainPerMarket: this.retentionMinPerMarket,
        now: this.now(),
      });

      if (plan.deleteIds.length === 0) {
        return {
          purgedCount: 0,
          disabled: false,
          marketCount: 0,
          cutoff: plan.cutoff?.toISOString(),
        };
      }

      // Guard against a concurrent run (or an operator) having already removed
      // rows since the scan: deleteMany returns the count actually deleted.
      const { count } = await this.prisma.tradeAuditEvent.deleteMany({
        id: { in: plan.deleteIds },
      });

      this.logger.info("Audit retention purge complete", {
        purgedCount: count,
        requestedCount: plan.deleteIds.length,
        marketCount: plan.marketCount,
        retentionDays: this.retentionDays,
        cutoff: plan.cutoff?.toISOString(),
      });

      if (count !== plan.deleteIds.length) {
        this.logger.warn(
          "Audit retention purged fewer rows than planned (concurrent modification)",
          { purgedCount: count, requestedCount: plan.deleteIds.length }
        );
      }

      return {
        purgedCount: count,
        disabled: false,
        marketCount: plan.marketCount,
        cutoff: plan.cutoff?.toISOString(),
      };
    } catch (error) {
      // Fail closed: leave the archive intact and keep the run successful.
      this.logger.error("Audit retention purge failed", {
        error: error instanceof Error ? error.message : String(error),
        retentionDays: this.retentionDays,
      });
      return { purgedCount: 0, disabled: false, marketCount: 0 };
    }
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
