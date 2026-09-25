import type { ILogger } from "../../../packages/shared/src/logger.js";
import type { BatchWriter, BatchRecord } from "./batchWriter.js";
import type { EventFetcher } from "./eventFetcher.js";
import type { InternalIndexerMetricsService } from "./metrics.js";
import { parseTradeEvents } from "./tradeParser.js";
import { parseResolutionEvents } from "./resolutionParser.js";
import { parseCollateralDepositedEvents } from "./collateralDepositedParser.js";
import { parseMarketCreatedEvents } from "./marketCreatedParser.js";
import { withIdempotencyKey } from "./idempotency.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GapPagingConfig {
  /**
   * Webhook URL to call when a persistent gap is detected.
   * Required in production to page operators.
   */
  webhookUrl: string;
  /**
   * Number of consecutive detection cycles where a gap persists
   * before triggering a page (minimum: 1).
   */
  persistenceCyclesBeforePage: number;
}

export interface GapDetectorConfig {
  /**
   * Ledger gap size at which the ingestion loop is fail-closed (paused).
   * A gap meeting or exceeding this value causes `runBackfill` to return
   * `{ paused: true }` and the caller is expected to halt.
   * Set to 0 to disable fail-closed behaviour.
   */
  gapPauseThreshold: number;
  /**
   * Maximum ledgers to back-fill in a single catch-up run.
   * Gaps wider than this are clamped and a warning is emitted.
   */
  backfillMaxLedgers: number;
  /** Soroban contract ID — forwarded to the event fetcher. */
  contractId: string;
  /**
   * Optional paging configuration for persistent gaps.
   * In production, this should be configured to alert operators.
   */
  pagingConfig?: GapPagingConfig;
  /** Current environment (dev, test, production). */
  nodeEnv?: string;
}

export interface GapDetectionResult {
  /** True when a gap was found in the processed batch sequence. */
  gapDetected: boolean;
  /**
   * First ledger sequence where the gap starts (i.e., the ledger after the
   * last contiguous ledger we have already indexed). Only set when
   * `gapDetected` is true.
   */
  gapStartLedger?: number;
  /**
   * Last ledger of the gap range (inclusive), capped at the network tip.
   * Only set when `gapDetected` is true.
   */
  gapEndLedger?: number;
  /** Size of the gap in ledgers. Only set when `gapDetected` is true. */
  gapSize?: number;
}

export interface BackfillResult {
  /** True when the gap was larger than gapPauseThreshold and the loop should halt. */
  paused: boolean;
  /** Number of ledgers that were successfully back-filled. */
  backfilledLedgers: number;
  /** Number of records written during the back-fill. */
  written: number;
  /** Number of records skipped (duplicates) during the back-fill. */
  skipped: number;
}

// ---------------------------------------------------------------------------
// GapDetector
// ---------------------------------------------------------------------------

/**
 * Detects discontinuous ledger sequences within a processed batch window and
 * drives a bounded, idempotent catch-up back-fill.
 *
 * ## Gap detection
 *
 * After each successful ingestion batch the caller passes:
 *   - `lastIndexedLedger`: the last ledger the ingestion loop confirmed as
 *     processed (the batch's end ledger).
 *   - `networkTipLedger`: the latest ledger reported by the Horizon/RPC node.
 *
 * A gap is detected when `networkTipLedger - lastIndexedLedger` exceeds
 * `ledgerWindowSize` **and** the observed events within the batch show a
 * discontinuous sequence (holes). This prevents false positives caused by
 * normal poll lag (the indexer not having caught up to the tip yet).
 *
 * Additionally, within-window gaps (holes inside the fetched range) are
 * detected by inspecting the set of ledger sequences present in the returned
 * events. If any integer in `[startLedger, endLedger]` is absent from the
 * event ledger set _and_ those ledgers are below the network tip, they are
 * flagged as a gap.
 *
 * ## Bounded back-fill
 *
 * `runBackfill` re-fetches the gap range using `EventFetcher.fetchByLedgerWindow`
 * and persists the results via `BatchWriter`, which honours the existing
 * `withIdempotencyKey` → `indexer_processed_events` deduplication layer.
 * Duplicate rows are never inserted.
 *
 * ## Fail-closed
 *
 * When the gap size meets or exceeds `gapPauseThreshold` (and the threshold is
 * > 0), `runBackfill` returns `{ paused: true }`. The ingestion loop is
 * expected to stop scheduling new ticks and alert operators.
 *
 * ## Persistent gap paging
 *
 * When a gap is detected in consecutive cycles (exceeding the persistence
 * threshold), an operator alert is triggered via a configurable webhook.
 * In production, this webhook must be configured to fail-fast.
 */
export class GapDetector {
  private lastGapStartLedger: number | null = null;
  private persistentGapCycles = 0;
  private hasPagedForCurrentGap = false;

  constructor(
    private readonly config: GapDetectorConfig,
    private readonly eventFetcher: EventFetcher,
    private readonly batchWriter: BatchWriter,
    private readonly metrics: InternalIndexerMetricsService,
    private readonly logger: ILogger
  ) {
    const isProd = config.nodeEnv === "production";
    if (isProd && !config.pagingConfig?.webhookUrl) {
      throw new Error(
        "Production indexer requires INDEXER_GAP_PAGING_WEBHOOK_URL to be configured"
      );
    }
  }

  // -------------------------------------------------------------------------
  // Gap detection
  // -------------------------------------------------------------------------

  /**
   * Examines the ledger sequences present in a just-processed batch and
   * returns a description of any gap found.
   *
   * @param startLedger   - First ledger of the batch window (inclusive).
   * @param endLedger     - Last ledger of the batch window (inclusive), capped
   *                        at the network tip.
   * @param networkTip    - Current latest ledger on the network.
   * @param seenLedgers   - Set of ledger sequences actually observed in the
   *                        fetched events. May be empty for quiet windows.
   */
  detectGap(
    startLedger: number,
    endLedger: number,
    networkTip: number,
    seenLedgers: ReadonlySet<number>
  ): GapDetectionResult {
    // No gap possible if we haven't fetched anything yet or the window
    // is already at/beyond the tip.
    if (startLedger > networkTip || endLedger < startLedger) {
      return { gapDetected: false };
    }

    // Find the first missing ledger in [startLedger, endLedger] that is
    // also known to be finalised (i.e., below or at networkTip).
    // We only flag a gap when the missing ledger is ≤ networkTip — a ledger
    // beyond the tip simply hasn't been produced yet and is not a gap.
    //
    // In practice Stellar ledgers emit events even when the contract is
    // quiet, so every ledger in the window *should* be present in the
    // fetched set. However, the RPC may omit ledgers with no matching
    // contract events, so we distinguish "ledger absent from event set"
    // from "ledger skipped by the cursor".
    //
    // The real-world gap we need to catch is: the *cursor* itself jumped
    // non-contiguously — i.e. the ingestion loop's `startLedger` is already
    // higher than `lastIndexedLedger + 1`. That is tracked via
    // `detectCursorGap` below.
    //
    // Within a window, missing event-ledgers are only meaningful when we
    // know events were expected. We leave that judgement to the caller and
    // simply scan here.
    let firstMissing: number | null = null;
    for (let seq = startLedger; seq <= Math.min(endLedger, networkTip); seq++) {
      if (!seenLedgers.has(seq)) {
        firstMissing = seq;
        break;
      }
    }

    if (firstMissing === null) {
      return { gapDetected: false };
    }

    const gapEndLedger = Math.min(endLedger, networkTip);
    const gapSize = gapEndLedger - firstMissing + 1;

    return {
      gapDetected: true,
      gapStartLedger: firstMissing,
      gapEndLedger,
      gapSize,
    };
  }

  /**
   * Detects a cursor-level gap: the situation where the ingestion cursor
   * advanced to `lastIndexedLedger` but the expected next ledger
   * (`lastIndexedLedger + 1`) is not the same as `batchStartLedger`.
   *
   * This catches cases where:
   *   - A batch fetch was skipped entirely.
   *   - A previous partial failure left a hole in the cursor's timeline.
   *   - The cursor was manually advanced past unprocessed ledgers.
   */
  detectCursorGap(
    lastIndexedLedger: number,
    batchStartLedger: number,
    networkTip: number
  ): GapDetectionResult {
    const expectedNext = lastIndexedLedger + 1;
    if (batchStartLedger <= expectedNext) {
      return { gapDetected: false };
    }

    // There is a gap between expectedNext and batchStartLedger - 1
    const gapEndLedger = Math.min(batchStartLedger - 1, networkTip);
    if (gapEndLedger < expectedNext) {
      return { gapDetected: false };
    }

    const gapSize = gapEndLedger - expectedNext + 1;
    return {
      gapDetected: true,
      gapStartLedger: expectedNext,
      gapEndLedger,
      gapSize,
    };
  }

  // -------------------------------------------------------------------------
  // Private paging helper
  // -------------------------------------------------------------------------

  /**
   * Sends a page to operators when a persistent gap is detected.
   * Non-blocking: errors are logged but do not throw.
   */
  private async pageOperatorsForPersistentGap(
    gapStartLedger: number,
    gapEndLedger: number,
    gapSize: number
  ): Promise<void> {
    const webhookUrl = this.config.pagingConfig?.webhookUrl;
    if (!webhookUrl) {
      return;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alert: "persistent_ledger_gap",
          contractId: this.config.contractId,
          gapStartLedger,
          gapEndLedger,
          gapSize,
          persistentCycles: this.persistentGapCycles,
          timestamp: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        this.logger.warn("Gap paging webhook returned non-2xx status", {
          event: "indexer.gap.paging.webhook_error",
          status: response.status,
          webhookUrl,
        });
      }
    } catch (error) {
      this.logger.warn("Failed to send gap paging alert", {
        event: "indexer.gap.paging.error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Bounded back-fill
  // -------------------------------------------------------------------------

  /**
   * Re-fetches and persists events for the given gap range.
   *
   * - The range is clamped to `backfillMaxLedgers` to prevent unbounded
   *   catch-up runs.
   * - Writes go through the existing `BatchWriter` → `withIdempotencyKey`
   *   path, so the operation is fully idempotent.
   * - Emits `gap_detected_total` and `backfill_ledgers_total` metrics.
   * - Returns `{ paused: true }` when the unclamped gap size meets or exceeds
   *   `gapPauseThreshold` (fail-closed).
   * - Tracks persistent gaps and pages operators when a gap recurs
   *   across multiple consecutive cycles.
   *
   * @param gapStartLedger - First missing ledger (inclusive).
   * @param gapEndLedger   - Last missing ledger (inclusive).
   */
  async runBackfill(
    gapStartLedger: number,
    gapEndLedger: number
  ): Promise<BackfillResult> {
    const rawGapSize = gapEndLedger - gapStartLedger + 1;

    this.metrics.incrementGapDetected();

    // Track persistent gaps: if the gap we're seeing is the same ledger range
    // as before (or overlapping), increment the cycle counter; otherwise reset.
    const isSameGap =
      this.lastGapStartLedger !== null &&
      this.lastGapStartLedger === gapStartLedger;

    if (isSameGap) {
      this.persistentGapCycles += 1;
    } else {
      this.persistentGapCycles = 1;
      this.hasPagedForCurrentGap = false;
    }
    this.lastGapStartLedger = gapStartLedger;

    // Page operators if gap persists beyond threshold (only once per gap)
    const { pagingConfig } = this.config;
    if (
      pagingConfig &&
      this.persistentGapCycles >= pagingConfig.persistenceCyclesBeforePage &&
      !this.hasPagedForCurrentGap
    ) {
      this.hasPagedForCurrentGap = true;
      this.logger.info("Paging operators for persistent gap", {
        event: "indexer.gap.paging.triggered",
        gapStartLedger,
        gapEndLedger,
        gapSize: rawGapSize,
        persistentCycles: this.persistentGapCycles,
      });
      await this.pageOperatorsForPersistentGap(
        gapStartLedger,
        gapEndLedger,
        rawGapSize
      );
    }

    // Fail-closed check — must happen before clamping so the operator sees
    // the true gap size in the log even when pausing.
    const { gapPauseThreshold } = this.config;
    if (gapPauseThreshold > 0 && rawGapSize >= gapPauseThreshold) {
      this.logger.error(
        "Ledger gap exceeds fail-closed threshold — pausing ingestion loop",
        {
          event: "indexer.gap.pause",
          gapStartLedger,
          gapEndLedger,
          gapSize: rawGapSize,
          gapPauseThreshold,
        }
      );
      return { paused: true, backfilledLedgers: 0, written: 0, skipped: 0 };
    }

    // Clamp to backfillMaxLedgers
    const { backfillMaxLedgers } = this.config;
    const clampedEnd = Math.min(
      gapEndLedger,
      gapStartLedger + backfillMaxLedgers - 1
    );
    const backfillSize = clampedEnd - gapStartLedger + 1;

    if (clampedEnd < gapEndLedger) {
      this.logger.warn(
        "Ledger gap exceeds backfillMaxLedgers — clamping catch-up range",
        {
          event: "indexer.gap.clamped",
          gapStartLedger,
          gapEndLedger,
          rawGapSize,
          clampedEnd,
          backfillMaxLedgers,
        }
      );
    }

    this.logger.info("Starting ledger gap back-fill", {
      event: "indexer.gap.backfill.start",
      gapStartLedger,
      gapEndLedger: clampedEnd,
      backfillSize,
    });

    // Fetch events for the gap range
    const { events } = await this.eventFetcher.fetchByLedgerWindow({
      startLedger: gapStartLedger,
      endLedger: clampedEnd,
    });

    // Parse all event types (backfill doesn't have telemetry, so no metrics for unknown topics)
    const { trades } = parseTradeEvents(events);
    const { resolutions } = parseResolutionEvents(events);
    const { deposits } = parseCollateralDepositedEvents(events);
    const { markets } = parseMarketCreatedEvents(events);

    const records: BatchRecord[] = [
      ...markets.map((market): BatchRecord => ({
        kind: "market_created",
        data: withIdempotencyKey(market),
      })),
      ...trades.map((trade): BatchRecord => ({
        kind: "trade",
        data: withIdempotencyKey(trade),
      })),
      ...resolutions.map((resolution): BatchRecord => ({
        kind: "resolution",
        data: withIdempotencyKey(resolution),
      })),
      ...deposits.map((deposit): BatchRecord => ({
        kind: "collateral_deposited",
        data: withIdempotencyKey(deposit),
      })),
    ];

    let written = 0;
    let skipped = 0;

    if (records.length > 0) {
      const writeResult = await this.batchWriter.write(records);
      written = writeResult.written;
      skipped = writeResult.skipped;

      if (writeResult.errors.length > 0) {
        this.logger.warn("Back-fill batch write completed with errors", {
          event: "indexer.gap.backfill.write_errors",
          gapStartLedger,
          gapEndLedger: clampedEnd,
          writeErrors: writeResult.errors.length,
          written,
          skipped,
        });
      }
    }

    this.metrics.incrementBackfillLedgers(backfillSize);

    this.logger.info("Ledger gap back-fill complete", {
      event: "indexer.gap.backfill.complete",
      gapStartLedger,
      gapEndLedger: clampedEnd,
      backfillSize,
      eventsFound: events.length,
      written,
      skipped,
    });

    return { paused: false, backfilledLedgers: backfillSize, written, skipped };
  }
}
