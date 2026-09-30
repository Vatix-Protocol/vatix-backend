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

/**
 * Stable error code surfaced when a checkpoint commit cannot be completed
 * atomically. Callers/operators can rely on this code for alerting and
 * runbook automation without parsing free-form messages.
 */
export const CHECKPOINT_COMMIT_FAILED = "INDEXER_CHECKPOINT_COMMIT_FAILED";

/**
 * Raised when the batch write and checkpoint advancement cannot be committed
 * as a single all-or-nothing unit. The checkpoint is NOT advanced when this
 * is thrown, so a subsequent tick re-processes the same window (idempotent
 * replay) rather than skipping events.
 */
export class CheckpointCommitError extends Error {
  readonly code = CHECKPOINT_COMMIT_FAILED;
  readonly correlationId: string;

  constructor(message: string, correlationId: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "CheckpointCommitError";
    this.correlationId = correlationId;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

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
          // Atomic commit: only advance the in-memory cursor once the batch
          // write has been durably persisted. If the write failed, the
          // checkpoint must NOT move so the same window is re-processed
          // (idempotent replay) instead of silently skipping events.
          if (!batchResult.batchWriteSucceeded) {
            const correlationId = this.buildCorrelationId(
              batchResult.lastIndexedLedgerSequence
            );
            this.metrics.incrementIngestionErrors?.("checkpoint_commit_failed");
            this.logger.error(
              "Checkpoint commit aborted: batch write did not succeed — checkpoint not advanced",
              {
                event: "indexer.checkpoint.commit_failed",
                code: CHECKPOINT_COMMIT_FAILED,
                correlationId,
                attemptedCursor: batchResult.nextCursor,
                retainedCursor: this.cursor,
                lastIndexedLedgerSequence:
                  batchResult.lastIndexedLedgerSequence,
              }
            );
            throw new CheckpointCommitError(
              "Batch write failed; checkpoint advancement aborted to preserve atomicity",
              correlationId
            );
          }

          this.cursor = batchResult.nextCursor;
          this.metrics.setLatestIndexedLedgerSequence(
            batchResult.lastIndexedLedgerSequence
          );
          this.successfulBatchesSinceLastCheckpoint += 1;
          this.batchesSinceLastHeartbeat += 1;
          await this.flushCheckpoint(false);
        }
      } catch (error) {
        if (error instanceof CheckpointCommitError) {
          this.logger.error("Ingestion tick failed (checkpoint commit)", {
            event: "indexer.checkpoint.commit_failed",
            code: error.code,
            correlationId: error.correlationId,
            error: error.message,
          });
        } else {
          this.logger.error("Ingestion tick failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        this.isTickInProgress = false;
        this.activeTickPromise = null;
      }
    })();

    await this.activeTickPromise;
  }

  /**
   * Builds a stable, non-secret correlation id for a checkpoint commit
   * attempt so operators can trace a failed commit across logs and metrics.
   */
  private buildCorrelationId(lastIndexedLedgerSequence: number): string {
    return `ckpt-${this.deps.contractId}-${lastIndexedLedgerSequence}`;
  }

  private async flushCheckpoint(force: boolean): Promise<void> {
    if (!this.cursor) {
      return;
    }

    if (
      !force &&
      this.successfulBatchesSinceLastCheckpoint <
        this.checkpointFlushE

/* … truncated 5324 chars — edit only what you need near the top … */
