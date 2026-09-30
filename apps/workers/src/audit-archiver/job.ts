import { createHash } from "crypto";
import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import { redis } from "../../../../src/services/redis.js";
import type { AuditArchiverJobResult, ArchivedEventResult } from "./types.js";

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
      // Absolute deadline for the whole run. `maxRunMs: 0` means "no budget"
      // and is represented as `null` so the checks stay a cheap comparison.
      const deadline =
        this.maxRunMs > 0 ? startedAt.getTime() + this.maxRunMs : null;

      for (const market of markets) {
        if (deadline !== null && Date.now() >= deadline) {
          this.logger.warn("Audit archiver exceeded maxRunMs, stopping early", {
            maxRunMs: this.maxRunMs,
            processedSoFar: results.length,
            remainingMarkets: markets.length - markets.indexOf(market),
          });
          break;
        }

        const marketResults = await this.archiveMarket(market, deadline);
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
  private async archiveMarket(
    marketId: string,
    deadline: number | null
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
      // Where this pass started, so `persistWatermark` can tell "advanced" from
      // "never moved" and avoid recording a no-op watermark.
      const startCursor = cursor;

      // Hash-chain state for this market, threaded through the batch loop in
      // memory instead of re-read per event (see `getPrevHash`).
      let prevHash = await this.getPrevHash(marketId);
      // Set when an event fails to archive. The run then stops this market
      // instead of re-reading the same poisoned entry forever.
      let aborted = false;

      while (!aborted) {
        const entries = await redis.xrange(
          streamKey,
          `(${cursor}`,
          "+",
          "COUNT",
          this.batchSize.toString()
        );

        if (entries.length === 0) break;

        for (const [streamId, fields] of entries) {
          // `maxRunMs` is a hard budget for the whole job, not per market. A
          // single busy market can otherwise run for far longer than the
          // configured budget and starve every other market, because the only
          // deadline check lived in the per-market loop in `run()`.
          if (deadline !== null && Date.now() >= deadline) {
            this.logger.warn(
              "Audit archiver exceeded maxRunMs mid-market, deferring remainder",
              {
                marketId,
                streamId,
                processedSoFar: results.length,
              }
            );
            aborted = true;
            break;
          }

          const parseResult = this.parseStreamFields(fields);
          if (!parseResult) {
            // Empty field set: nothing to archive, but the entry is consumed
            // so the cursor can move past it.
            results.push({
              marketId,
              streamId,
              status: "skipped",
            });
            cursor = streamId;
            continue;
          }

          // `tradeId` is the audit row's subject. Without it the row is
          // unattributable, so it is rejected rather than written with a
          // null/empty subject that would poison later chain verification.
          const tradeId = parseResult.logData.tradeId;
          if (typeof tradeId !== "string" || tradeId.length === 0) {
            this.logger.error("Audit entry missing tradeId, not archiving", {
              marketId,
              streamId,
            });
            results.push({
              marketId,
              streamId,
              status: "error",
              errorMessage: "audit entry has no tradeId field",
            });
            aborted = true;
            break;
          }

          try {
            const payload = JSON.stringify(parseResult.logData);
            const entryHash = this.computeHash(payload, prevHash);

            // Archive to Postgres (upsert)
            await this.prisma.tradeAuditEvent.upsert({
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

            results.push({
              marketId,
              streamId,
              status: "archived",
            });

            // Only advance the chain after the row is durably written, so a
            // failed write cannot leave the next entry linked to a hash that
            // was never stored.
            prevHash = entryHash;
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
            // Stop this market. The cursor was not advanced past the failed
            // entry, so the watermark is not moved over it and the next run
            // retries it — at-least-once, never a silent skip. Continuing the
            // loop would re-read the same entry on every iteration and spin
            // for the lifetime of the process.
            aborted = true;
            break;
          }
        }

        if (aborted) {
          // The run budget (or a poisoned entry) cut this market short. Any
          // entry processed before that point *was* durably written and the
          // cursor only advances after a successful upsert, so persisting the
          // watermark makes the resume point exact: the next run resumes at the
          // first *unarchived* entry instead of re-reading and re-hashing
          // everything already archived. If the cursor never moved there is
          // nothing to record — the failed entry stays unarchived and is
          // retried, which is at-least-once, never a silent skip.
          await this.persistWatermark(marketId, cursor, watermark, startCursor);
          break;
        }

        // Update watermark after batch
        if (cursor !== watermark?.marketStreamId) {
          await this.persistWatermark(marketId, cursor, watermark, startCursor);
          // The watermark moved, so re-read the chain tail once per batch: a
          // concurrent archiver may have appended rows since the last read.
          prevHash = await this.getPrevHash(marketId);
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
   * Move this market's archive watermark to `cursor`.
   *
   * `globalStreamId` is only populated on create and is intentionally left
   * untouched on update: this job archives the per-market stream only, so it
   * has no global-stream position to advance, and overwriting the column with a
   * market-stream id would misreport progress on `GET /audit/watermark`.
   */
  private async persistWatermark(
    marketId: string,
    cursor: string,
    watermark: { marketStreamId: string } | null,
    startCursor: string
  ): Promise<void> {
    // No progress was made this pass, so there is nothing new to record.
    if (cursor === startCursor || cursor === watermark?.marketStreamId) {
      return;
    }
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
   *
   * Ordered by `streamId desc`, **not** `archivedAt desc`. Redis stream IDs are
   * monotonically increasing and are what defines the chain's order, whereas
   * `archivedAt` is a wall-clock write timestamp: two entries archived inside
   * the same millisecond, or an entry re-archived later by a replay, can order
   * differently from the chain itself. Linking to the wrong predecessor makes
   * `verifyChain` report a false gap (`vatix_audit_chain_gap_total`) and breaks
   * the tamper-evidence property the chain exists to provide.
   *
   * Returns `"0"` — the documented chain root — when the market has no
   * archived entries yet.
   */
  private async getPrevHash(marketId: string): Promise<string> {
    const lastEvent = await this.prisma.tradeAuditEvent.findFirst({
      where: { marketId },
      orderBy: { streamId: "desc" },
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
