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
import {
  withIdempotencyKey,
  generateIdempotencyKey,
} from "./idempotency.js";
import type { RawChainEvent } from "./types.js";
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
        this.checkpointFlushEveryBatches
    ) {
      return;
    }

    const cursorToPersist = this.cursor;
    try {
      await this.storage.saveCursor(cursorToPersist);
      this.successfulBatchesSinceLastCheckpoint = 0;
    } catch (error) {
      const correlationId = this.buildCorrelationId(
        Number(cursorToPersist) || 0
      );
      this.metrics.incrementIngestionErrors?.("checkpoint_commit_failed");
      this.logger.error(
        "Checkpoint commit failed — cursor not advanced",
        {
          event: "indexer.checkpoint.commit_failed",
          code: CHECKPOINT_COMMIT_FAILED,
          correlationId,
          attemptedCursor: cursorToPersist,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      throw new CheckpointCommitError(
        "Failed to persist checkpoint cursor",
        correlationId,
        { cause: error }
      );
    }
  }

  /**
   * Runs a single ingestion batch: fetch the next ledger window, parse every
   * supported event type, stamp idempotency keys, write the batch, and report
   * the cursor the checkpoint may advance to.
   *
   * The returned `batchWriteSucceeded` flag is the atomicity guard: the caller
   * only advances the cursor when it is true.
   */
  private async ingestFromCursor(
    cursor: string | null
  ): Promise<IngestionBatchResult> {
    const parsedCursor = cursor === null ? 0 : Number(cursor);
    const cursorIsValid = Number.isFinite(parsedCursor) && parsedCursor >= 0;
    if (!cursorIsValid) {
      this.logger.warn(
        "Stale or corrupted cursor detected — resetting to ledger 0",
        { cursor, action: "reset_to_zero" }
      );
    }
    const safeCurrentSequence = cursorIsValid ? parsedCursor : 0;

    if (this.deps.ledgerWindowSize < 1) {
      this.logger.error("Invalid ledgerWindowSize — must be >= 1", {
        ledgerWindowSize: this.deps.ledgerWindowSize,
      });
      return {
        nextCursor: String(safeCurrentSequence),
        lastIndexedLedgerSequence: safeCurrentSequence,
        batchWriteSucceeded: false,
      };
    }

    const startLedger = safeCurrentSequence + 1;
    const endLedger = safeCurrentSequence + this.deps.ledgerWindowSize;

    const fetchSpan = this.telemetry.startSpan("indexer.fetch", {
      startLedger: String(startLedger),
      endLedger: String(endLedger),
    });
    let events: RawChainEvent[];
    let latestLedger: number;
    try {
      const fetched = await this.deps.eventFetcher.fetchByLedgerWindow({
        startLedger,
        endLedger,
      });
      events = fetched.events;
      latestLedger = fetched.latestLedger;
    } finally {
      fetchSpan.end();
    }

    this.metrics.setLatestNetworkLedgerSequence(latestLedger);

    // Reorg detection: compare the network tip against the last known tip.
    const latestInfo = await this.deps.eventFetcher.getLatestLedgerInfo();
    const reorgDetected =
      this.lastKnownLatestLedger !== null &&
      (latestInfo.sequence < this.lastKnownLatestLedger ||
        (latestInfo.sequence === this.lastKnownLatestLedger &&
          this.lastKnownLatestHash !== null &&
          latestInfo.hash !== this.lastKnownLatestHash));

    if (reorgDetected) {
      const rewindDepth =
        this.deps.ledgerWindowSize * REORG_REWIND_DEPTH_MULTIPLIER;
      const rewound = Math.max(0, safeCurrentSequence - rewindDepth);
      this.logger.warn("Chain reorganisation detected — rewinding cursor", {
        event: "indexer.reorg.detected",
        previousLatestLedger: this.lastKnownLatestLedger,
        latestLedger: latestInfo.sequence,
        previousHash: this.lastKnownLatestHash,
        latestHash: latestInfo.hash,
        rewoundCursor: rewound,
      });
      this.lastKnownLatestLedger = latestInfo.sequence;
      this.lastKnownLatestHash = latestInfo.hash;
      try {
        await this.storage.saveLedgerHash(latestInfo.hash);
      } catch {
        this.logger.warn("Failed to persist ledger hash after reorg", {});
      }
      return {
        nextCursor: String(rewound),
        lastIndexedLedgerSequence: rewound,
        batchWriteSucceeded: false,
      };
    }

    this.lastKnownLatestLedger = latestInfo.sequence;
    this.lastKnownLatestHash = latestInfo.hash;
    try {
      await this.storage.saveLedgerHash(latestInfo.hash);
    } catch {
      this.logger.warn("Failed to persist ledger hash", {});
    }

    const parseSpan = this.telemetry.startSpan("indexer.parse", {
      eventCount: String(events.length),
    });
    const records: BatchRecord[] = [];
    try {
      const { trades, errors: tradeErrors } = parseTradeEvents(events);
      for (const err of tradeErrors) {
        this.metrics.incrementParseError("trade");
        this.logger.warn("Trade parse error — skipping event", {
          eventId: err.eventId,
          error: err.message,
        });
      }
      const { resolutions, errors: resolutionErrors } =
        parseResolutionEvents(events);
      for (const err of resolutionErrors) {
        this.metrics.incrementParseError("resolution");
        this.logger.warn("Resolution parse error — skipping event", {
          eventId: err.eventId,
          error: err.message,
        });
      }
      const { deposits, errors: depositErrors } =
        parseCollateralDepositedEvents(events);
      for (const err of depositErrors) {
        this.metrics.incrementParseError("collateral_deposited");
        this.logger.warn("Collateral deposit parse error — skipping event", {
          eventId: err.eventId,
          error: err.message,
        });
      }
      const { markets, errors: marketErrors } =
        parseMarketCreatedEvents(events);
      for (const err of marketErrors) {
        this.metrics.incrementParseError("market_created");
        this.logger.warn("Market created parse error — skipping event", {
          eventId: err.eventId,
          error: err.message,
        });
      }

      records.push(
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
        }))
      );
    } finally {
      parseSpan.end();
    }

    const parsedEventIds = new Set(
      records.map((record) => record.data.idempotencyKey)
    );
    for (const event of events) {
      let key: string;
      try {
        key = generateIdempotencyKey(event).key;
      } catch {
        continue;
      }
      if (!parsedEventIds.has(key)) {
        this.logger.warn("Unknown event type — no matching parser found", {
          eventId: event.id,
          ledger: event.ledger,
        });
      }
    }

    const nextCursor = String(endLedger);
    const writeSpan = this.telemetry.startSpan("indexer.write", {
      recordCount: String(records.length),
      nextCursor,
    });
    let batchWriteSucceeded = true;
    try {
      const writeResult = await this.deps.batchWriter.write(records);
      if (writeResult.errors.length > 0) {
        batchWriteSucceeded = false;
        this.logger.error("Batch write completed with errors", {
          event: "indexer.batch.write_errors",
          written: writeResult.written,
          skipped: writeResult.skipped,
          writeErrors: writeResult.errors.length,
        });
      }
    } catch (error) {
      batchWriteSucceeded = false;
      this.logger.error("Batch write failed", {
        event: "indexer.batch.write_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      writeSpan.end();
    }

    return {
      nextCursor,
      lastIndexedLedgerSequence: endLedger,
      batchWriteSucceeded,
    };
  }

  private emitHeartbeat(): void {
    const latestIndexed = this.metrics.getLatestIndexedLedgerSequence();
    this.logger.info("Indexer ingestion heartbeat", {
      event: "indexer.heartbeat",
      cursor: this.cursor,
      latestIndexedLedgerSequence: latestIndexed,
      latestNetworkLedgerSequence:
        this.metrics.getLatestNetworkLedgerSequence(),
      lag: this.metrics.getLag(),
      batchesSinceLastHeartbeat: this.batchesSinceLastHeartbeat,
      lastHeartbeatLedgerSequence: this.lastHeartbeatLedgerSequence,
      metrics: this.metrics.toLogFields(),
    });
    this.batchesSinceLastHeartbeat = 0;
    this.lastHeartbeatLedgerSequence = latestIndexed;
  }
}
