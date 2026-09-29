import type { ILogger } from "../../../packages/shared/src/logger.js";
import type { CursorStorageClient } from "./storage.js";
import type { InternalIndexerMetricsService } from "./metrics.js";
import type { BatchWriter, BatchRecord } from "./batchWriter.js";
import type { EventFetcher } from "./eventFetcher.js";
import type { Telemetry } from "./telemetry.js";
import { consoleTelemetry } from "./telemetry.js";
import { parseTradeEvents } from "./tradeParser.js";
import { parseResolutionEvents } from "./resolutionParser.js";
import { parseCollateralDepositedEvents } from "./collateralDepositedParser.js";
import { parseMarketCreatedEvents } from "./marketCreatedParser.js";
import { withIdempotencyKey } from "./idempotency.js";
import {
  TradeParseError,
  ResolutionParseError,
  CollateralDepositedParseError,
  MarketCreatedParseError,
} from "./types.js";
import { GapDetector, type GapPagingConfig } from "./gapDetector.js";

/**
 * Number of ledgers to rewind when a chain reorganisation is detected.
 * Rewinding by a full window ensures the indexer re-processes enough
 * history to catch any forked events.
 */
const REORG_REWIND_DEPTH_MULTIPLIER = 2;

export interface IngestionLoop {
  start(initialCursor: string | null): Promise<void>;
  stop(): Promise<void>;
}

export interface IngestionDependencies {
  eventFetcher: EventFetcher;
  batchWriter: BatchWriter;
  contractId: string;
  ledgerWindowSize: number;
  /** @see GapDetectorConfig.gapPauseThreshold */
  gapPauseThreshold?: number;
  /** @see GapDetectorConfig.backfillMaxLedgers */
  backfillMaxLedgers?: number;
  /** @see GapDetectorConfig.pagingConfig */
  gapPagingConfig?: GapPagingConfig;
  /** @see GapDetectorConfig.nodeEnv */
  nodeEnv?: string;
  telemetry?: Telemetry;
}

interface IngestionBatchResult {
  nextCursor: string;
  lastIndexedLedgerSequence: number;
  batchWriteSucceeded: boolean;
}

const HEARTBEAT_INTERVAL_MS = 60_000;

export class PollingIngestionLoop implements IngestionLoop {
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isTickInProgress = false;
  private activeTickPromise: Promise<void> | null = null;
  private cursor: string | null = null;
  private successfulBatchesSinceLastCheckpoint = 0;
  private batchesSinceLastHeartbeat = 0;
  private lastHeartbeatLedgerSequence: number | null = null;

  /** Last known latest ledger sequence for reorg detection. */
  private lastKnownLatestLedger: number | null = null;
  /** Last known latest ledger hash for reorg detection. */
  private lastKnownLatestHash: string | null = null;

  /**
   * When true, the gap detector has triggered fail-closed mode.
   * No further ticks are scheduled; operators must resolve the gap and
   * restart the process.
   */
  private isPaused = false;

  /** GapDetector wired in for all ingestion ticks. */
  private readonly gapDetector: GapDetector;

  /** Emits spans for the fetch/parse/write stages of each ingestion batch. */
  private readonly telemetry: Telemetry;

  constructor(
    private readonly logger: ILogger,
    private readonly storage: CursorStorageClient,
    private readonly metrics: InternalIndexerMetricsService,
    private readonly intervalMs: number,
    private readonly checkpointFlushEveryBatches: number,
    private readonly deps: IngestionDependencies
  ) {
    this.telemetry = deps.telemetry ?? consoleTelemetry;
    this.gapDetector = new GapDetector(
      {
        gapPauseThreshold: deps.gapPauseThreshold ?? 1000,
        backfillMaxLedgers: deps.backfillMaxLedgers ?? 500,
        contractId: deps.contractId,
        pagingConfig: deps.gapPagingConfig,
        nodeEnv: deps.nodeEnv,
      },
      deps.eventFetcher,
      deps.batchWriter,
      metrics,
      logger
    );
  }

  async start(initialCursor: string | null): Promise<void> {
    this.cursor = initialCursor;
    const initialLedger = initialCursor ? Number(initialCursor) : null;
    if (initialLedger !== null && Number.isFinite(initialLedger)) {
      this.metrics.setLatestIndexedLedgerSequence(initialLedger);
    }

    // Load persisted ledger hash for reorg detection on startup
    try {
      this.lastKnownLatestHash = await this.storage.loadLedgerHash();
    } catch {
      this.logger.warn(
        "Failed to load persisted ledger hash — reorg detection will initialise on first tick",
        {}
      );
    }

    this.logger.info("Indexer ingestion loop starting", {
      startCursor: initialCursor,
      intervalMs: this.intervalMs,
      checkpointFlushEveryBatches: this.checkpointFlushEveryBatches,
      ledgerWindowSize: this.deps.ledgerWindowSize,
      contractId: this.deps.contractId,
      lastKnownHash: this.lastKnownLatestHash
        ? `${this.lastKnownLatestHash.slice(0, 16)}…`
        : null,
      gapPauseThreshold: this.deps.gapPauseThreshold ?? 1000,
      backfillMaxLedgers: this.deps.backfillMaxLedgers ?? 500,
    });

    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.heartbeatTimer = setInterval(
      () => this.emitHeartbeat(),
      HEARTBEAT_INTERVAL_MS
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.activeTickPromise) {
      this.logger.info(
        "Waiting for active ingestion tick to complete before stop..."
      );
      // Set 30 second timeout to prevent indefinite wait if tick hangs
      const tickTimeoutMs = 30_000;
      try {
        await Promise.race([
          this.activeTickPromise,
          new Promise<void>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Ingestion tick did not complete within ${tickTimeoutMs}ms`
                  )
                ),
              tickTimeoutMs
            )
          ),
        ]);
      } catch (error) {
        this.logger.warn("Ingestion tick timeout on shutdown", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.flushCheckpoint(true);

    this.logger.info("Indexer ingestion loop stopped", {
      finalCursor: this.cursor,
      latestIndexedLedgerSequence:
        this.metrics.getLatestIndexedLedgerSequence(),
    });
  }

  private async tick(): Promise<void> {
    // Fail-closed: once paused, refuse all further ticks.
    if (this.isPaused) {
      this.logger.warn(
        "Ingestion loop is paused (gap threshold exceeded) — skipping tick",
        { event: "indexer.gap.paused" }
      );
      return;
    }

    if (this.isTickInProgress) {
      this.logger.warn(
        "Skipping ingestion tick because previous tick is active"
      );
      return;
    }

    this.isTickInProgress = true;
    this.activeTickPromise = (async () => {
      try {
        const batchResult = await this.ingestFromCursor(this.cursor);
        if (batchResult.nextCursor && batchResult.nextCursor !== this.cursor) {
          this.cursor = batchResult.nextCursor;
          this.metrics.setLatestIndexedLedgerSequence(
            batchResult.lastIndexedLedgerSequence
          );
          this.successfulBatchesSinceLastCheckpoint += 1;
          this.batchesSinceLastHeartbeat += 1;
          await this.flushCheckpoint(false);
        }
      } catch (error) {
        this.logger.error("Ingestion tick failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.isTickInProgress = false;
        this.activeTickPromise = null;
      }
    })();

    await this.activeTickPromise;
  }

  private async flushCheckpoint(force: boolean): Promise<void> {
    if (!this.cursor) {
      return;
    }

    if (
      !force &&
      this.successfulBatchesSinceLastCheckpoint <
        this.checkpointFlushEveryBatches
    ) {
      return;
    }

    try {
      await this.storage.saveCursor(this.cursor);
      this.successfulBatchesSinceLastCheckpoint = 0;
    } catch (error) {
      this.logger.error("Failed to persist ingestion cursor", {
        cursor: this.cursor,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emitHeartbeat(): void {
    const latest = this.metrics.getLatestIndexedLedgerSequence();
    const advanced =
      this.lastHeartbeatLedgerSequence === null ||
      latest !== this.lastHeartbeatLedgerSequence;

    this.logger.info("Indexer heartbeat", {
      event: "indexer.heartbeat",
      cursor: this.cursor,
      latestIndexedLedgerSequence: latest,
      batchesSinceLastHeartbeat: this.batchesSinceLastHeartbeat,
      advanced,
    });

    this.lastHeartbeatLedgerSequence = latest;
    this.batchesSinceLastHeartbeat = 0;
  }

  /**
   * Fetches, parses, and writes a single batch of events starting from the
   * given cursor. Returns the next cursor and the last indexed ledger.
   *
   * Fail-closed semantics: if the batch write fails, the cursor is NOT
   * advanced and the caller must not persist a new checkpoint. This ensures
   * no partial/corrupt market rows are committed and replayed events are
   * handled idempotently via {@link withIdempotencyKey}.
   */
  private async ingestFromCursor(
    cursor: string | null
  ): Promise<IngestionBatchResult> {
    const startLedger = cursor ? Number(cursor) : 0;
    const endLedger = startLedger + this.deps.ledgerWindowSize;

    const span = this.telemetry.startSpan("indexer.ingestBatch", {
      startLedger,
      endLedger,
      contractId: this.deps.contractId,
    });

    let events;
    try {
      events = await this.deps.eventFetcher.fetchEvents({
        contractId: this.deps.contractId,
        startLedger,
        endLedger,
      });
    } catch (error) {
      span.recordError(error);
      span.end();
      // Fail-closed: dependency (RPC) outage must not advance the cursor.
      throw error;
    }

    const records: BatchRecord[] = [];

    try {
      const tradeEvents = parseTradeEvents(events);
      for (const trade of tradeEvents) {
        records.push({
          idempotencyKey: withIdempotencyKey("trade", trade),
          kind: "trade",
          payload: trade,
        });
      }
    } catch (error) {
      if (error instanceof TradeParseError) {
        this.logger.warn("Skipping malformed trade event", {
          code: error.code,
          error: error.message,
        });
      } else {
        throw error;
      }
    }

    try {
      const resolutionEvents = parseResolutionEvents(events);
      for (const resolution of resolutionEvents) {
        records.push({
          idempotencyKey: withIdempotencyKey("resolution", resolution),
          kind: "resolution",
          payload: resolution,
        });
      }
    } catch (error) {
      if (error instanceof ResolutionParseError) {
        this.logger.warn("Skipping malformed resolution event", {
          code: error.code,
          error: error.message,
        });
      } else {
        throw error;
      }
    }

    try {
      const collateralEvents = parseCollateralDepositedEvents(events);
      for (const collateral of collateralEvents) {
        records.push({
          idempotencyKey: withIdempotencyKey("collateral", collateral),
          kind: "collateral",
          payload: collateral,
        });
      }
    } catch (error) {
      if (error instanceof CollateralDepositedParseError) {
        this.logger.warn("Skipping malformed collateral event", {
          code: error.code,
          error: error.message,
        });
      } else {
        throw error;
      }
    }

    // Index MarketCreated events end-to-end so the API list endpoint can
    // surface newly created markets. Replayed/concurrent events are
    // deduplicated via the idempotency key derived from the event identity.
    try {
      const marketCreatedEvents = parseMarketCreatedEvents(events);
      for (const market of marketCreatedEvents) {
        records.push({
          idempotencyKey: withIdempotencyKey("marketCreated", market),
          kind: "marketCreated",
          payload: market,
        });
      }
    } catch (error) {
      if (error instanceof MarketCreatedParseError) {
        this.logger.warn("Skipping malformed marketCreated event", {
          code: error.code,
          error: error.message,
        });
      } else {
        throw error;
      }
    }

    let batchWriteSucceeded = true;
    if (records.length > 0) {
      try {
        await this.deps.batchWriter.writeBatch(records);
      } catch (error) {
        batchWriteSucceeded = false;
        span.recordError(error);
        this.logger.error("Failed to write ingestion batch", {
          recordCount: records.length,
          error: error instanceof Error ? error.message : String(error),
        });
        // Fail-closed: do not advance the cursor on write failure so the
        // batch is retried and no partial market rows are committed.
        span.end();
        throw error;
      }
    }

    span.end();

    return {
      nextCursor: String(endLedger),
      lastIndexedLedgerSequence: endLedger,
      batchWriteSucceeded,
    };
  }
}
