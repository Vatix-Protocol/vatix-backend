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
  /**
   * Upper bound (ms) for the failure backoff applied between ingestion ticks.
   *
   * The loop doubles its delay on every consecutive failure up to this
   * ceiling, so a downed RPC/DB is retried gently instead of at full
   * `intervalMs` forever, and recovers to `intervalMs` on the first healthy
   * tick. Set to 0 to disable backoff entirely (kill-switch: restores the
   * previous fixed-interval behaviour without a code change).
   */
  tickBackoffMaxMs?: number;
  /** Maximum time (ms) to wait for an in-flight tick during shutdown. */
  shutdownTimeoutMs?: number;
  telemetry?: Telemetry;
}

interface IngestionBatchResult {
  nextCursor: string;
  lastIndexedLedgerSequence: number;
  batchWriteSucceeded: boolean;
}

const HEARTBEAT_INTERVAL_MS = 60_000;

/** Default ceiling for the consecutive-failure backoff between ticks. */
const DEFAULT_TICK_BACKOFF_MAX_MS = 60_000;

/** Default bound on how long shutdown waits for an in-flight tick. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export class PollingIngestionLoop implements IngestionLoop {
  /**
   * Self-rescheduling single-shot timer. A `setInterval` cannot express a
   * per-tick backoff, and a fixed interval hammers a downed RPC/DB at full
   * rate for the entire outage.
   */
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isTickInProgress = false;
  private activeTickPromise: Promise<void> | null = null;
  /** Consecutive failed ticks; drives the backoff and the ops gauge. */
  private consecutiveTickFailures = 0;
  /** True once {@link stop} has run; blocks any further scheduling. */
  private isStopped = false;
  /** True once {@link start} has run; makes a double start a no-op. */
  private isStarted = false;
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
    // A second start() would leave the first loop's timer running and double
    // the ingestion rate against the same cursor. Refuse instead.
    if (this.isStarted && !this.isStopped) {
      this.logger.warn(
        "Ingestion loop already started — ignoring duplicate start()",
        {
          event: "indexer.ingestion.duplicate_start",
        }
      );
      return;
    }

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
      tickBackoffMaxMs:
        this.deps.tickBackoffMaxMs ?? DEFAULT_TICK_BACKOFF_MAX_MS,
    });

    this.isStarted = true;
    this.isStopped = false;
    this.heartbeatTimer = setInterval(
      () => this.emitHeartbeat(),
      HEARTBEAT_INTERVAL_MS
    );

    // Run the first tick inline so start() resolves only once the loop has
    // made its first (possibly failing) attempt, then hand over to the
    // self-rescheduling timer.
    await this.tick();
    this.scheduleNextTick(this.intervalMs);
  }

  /**
   * Schedules the next tick after `delayMs`. A single-shot timer (rather
   * than setInterval) is what allows the delay to grow with the consecutive
   * failure count and to be cancelled atomically on shutdown.
   */
  private scheduleNextTick(delayMs: number): void {
    if (this.isStopped || this.isPaused) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() =>
        this.scheduleNextTick(this.nextTickDelayMs())
      );
    }, delayMs);
  }

  /**
   * Delay before the next tick: the configured interval while healthy,
   * doubled per consecutive failure up to the configured ceiling.
   */
  private nextTickDelayMs(): number {
    if (this.consecutiveTickFailures === 0) {
      return this.intervalMs;
    }
    const maxMs = this.deps.tickBackoffMaxMs ?? DEFAULT_TICK_BACKOFF_MAX_MS;
    if (maxMs <= 0) {
      // Kill-switch: backoff disabled, always retry at the base interval.
      return this.intervalMs;
    }
    const exponent = Math.min(this.consecutiveTickFailures, 30);
    return Math.min(this.intervalMs * 2 ** exponent, maxMs);
  }

  /**
   * Records a failed tick: bumps the streak, exports the counters, and logs
   * the *next* delay so an operator can see the loop backing off instead of
   * silently retrying at full rate.
   */
  private recordTickFailure(error: unknown): void {
    this.consecutiveTickFailures += 1;
    this.metrics.incrementIngestionFailure(this.consecutiveTickFailures);
    this.telemetry.record("indexer.ingestion.tick_failed", 1, {
      consecutiveFailures: String(this.consecutiveTickFailures),
      nextDelayMs: String(this.nextTickDelayMs()),
    });
    this.logger.error("Ingestion tick failed", {
      event: "indexer.ingestion.tick_failed",
      error: error instanceof Error ? error.message : String(error),
      consecutiveTickFailures: this.consecutiveTickFailures,
      nextTickDelayMs: this.nextTickDelayMs(),
    });
  }

  /** Clears the failure streak after a healthy tick. */
  private recordTickSuccess(): void {
    if (this.consecutiveTickFailures > 0) {
      this.logger.info("Ingestion tick recovered", {
        event: "indexer.ingestion.tick_recovered",
        previousConsecutiveFailures: this.consecutiveTickFailures,
      });
    }
    this.consecutiveTickFailures = 0;
    this.metrics.resetIngestionFailures();
  }

  /**
   * Exposed for ops/tests: how many consecutive ticks have failed. Stays 0
   * while the loop is healthy.
   */
  getConsecutiveTickFailures(): number {
    return this.consecutiveTickFailures;
  }

  async stop(): Promise<void> {
    // Idempotent: a second stop() (double SIGTERM, or stop() after a failed
    // shutdown) must not re-flush or schedule anything.
    if (this.isStopped) {
      return;
    }
    this.isStopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
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
      // Bound the wait so a hung tick cannot block shutdown forever. The
      // timeout handle is always cleared — a leaked timer would keep the
      // event loop (and therefore the process) alive for the full 30s after
      // a *successful* drain.
      const tickTimeoutMs =
        this.deps.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.activeTickPromise,
          new Promise<void>((_, reject) => {
            timeoutId = setTimeout(
              () =>
                reject(
                  new Error(
                    `Ingestion tick did not complete within ${tickTimeoutMs}ms`
                  )
                ),
              tickTimeoutMs
            );
          }),
        ]);
      } catch (error) {
        this.logger.warn("Ingestion tick timeout on shutdown", {
          error: error instanceof Error ? error.message : String(error),
          shutdownTimeoutMs: tickTimeoutMs,
        });
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }

    // Fail-closed shutdown: a store outage must not turn into an unhandled
    // rejection that kills the process before the final log line. The cursor
    // stays on the previous value and the batch is re-ingested (idempotently)
    // on the next start.
    try {
      await this.flushCheckpoint(true);
    } catch (error) {
      this.logger.error("Final checkpoint flush failed on shutdown", {
        event: "indexer.ingestion.checkpoint_failed",
        phase: "shutdown",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.logger.info("Indexer ingestion loop stopped", {
      finalCursor: this.cursor,
      latestIndexedLedgerSequence:
        this.metrics.getLatestIndexedLedgerSequence(),
      consecutiveTickFailures: this.consecutiveTickFailures,
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
          // A checkpoint failure is *not* a processing failure: the batch is
          // already durably written and the cursor is retried on the next
          // tick, so it is logged separately and does not back the loop off.
          try {
            await this.flushCheckpoint(false);
          } catch (error) {
            this.logger.error(
              "Checkpoint flush failed — will retry next tick",
              {
                event: "indexer.ingestion.checkpoint_failed",
                phase: "tick",
                cursor: this.cursor,
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }
        this.recordTickSuccess();
      } catch (error) {
        this.recordTickFailure(error);
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

    await this.storage.saveCursor(this.cursor);

    // Persist the latest known ledger hash alongside the cursor so that
    // reorg detection survives restarts.
    if (this.lastKnownLatestHash) {
      await this.storage.saveLedgerHash(this.lastKnownLatestHash);
    }

    this.successfulBatchesSinceLastCheckpoint = 0;
    this.logger.debug("Persisted indexer checkpoint cursor", {
      cursor: this.cursor,
      latestIndexedLedgerSequence:
        this.metrics.getLatestIndexedLedgerSequence(),
      forced: force,
    });
  }

  private emitHeartbeat(): void {
    const latestIndexedLedgerSequence =
      this.metrics.getLatestIndexedLedgerSequence();
    const ledgerDelta =
      latestIndexedLedgerSequence !== null &&
      this.lastHeartbeatLedgerSequence !== null
        ? latestIndexedLedgerSequence - this.lastHeartbeatLedgerSequence
        : null;

    this.logger.info("Indexer heartbeat", {
      ...this.metrics.toLogFields(),
      event: "indexer.heartbeat",
      cursor: this.cursor,
      latestIndexedLedgerSequence,
      batchesProcessed: this.batchesSinceLastHeartbeat,
      ledgerDelta,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      isPaused: this.isPaused,
      consecutiveTickFailures: this.consecutiveTickFailures,
      nextTickDelayMs: this.nextTickDelayMs(),
    });

    this.batchesSinceLastHeartbeat = 0;
    this.lastHeartbeatLedgerSequence = latestIndexedLedgerSequence;
  }

  /**
   * Fetches the current latest ledger hash from the RPC node.
   * Returns null on transient errors so that reorg detection degrades
   * gracefully rather than throwing.
   */
  private async fetchLatestLedgerHash(): Promise<string | null> {
    try {
      const info = await this.deps.eventFetcher.getLatestLedgerInfo();
      return info.hash;
    } catch {
      this.logger.warn(
        "Failed to fetch latest ledger hash for reorg check",
        {}
      );
      return null;
    }
  }

  private async ingestFromCursor(
    currentCursor: string | null
  ): Promise<IngestionBatchResult> {
    this.logger.debug("Running ingestion tick", { cursor: currentCursor });

    const currentSequence = currentCursor ? Number(currentCursor) : 0;
    const isValidCursor =
      currentCursor === null ||
      (Number.isFinite(currentSequence) && currentSequence >= 0);

    if (!isValidCursor) {
      this.logger.warn(
        "Stale or corrupted cursor detected — resetting to ledger 0",
        {
          cursor: currentCursor,
          parsedValue: currentSequence,
          action: "reset_to_zero",
        }
      );
    }

    const safeCurrentSequence = isValidCursor ? currentSequence : 0;

    // Validate ledger window size bounds (Issue #711)
    if (this.deps.ledgerWindowSize < 1) {
      this.logger.error("Invalid ledgerWindowSize — must be >= 1", {
        ledgerWindowSize: this.deps.ledgerWindowSize,
      });
      return {
        nextCursor: currentCursor ?? String(safeCurrentSequence),
        lastIndexedLedgerSequence: safeCurrentSequence,
        batchWriteSucceeded: false,
      };
    }

    const startLedger = safeCurrentSequence + 1;
    const provisionalEnd = startLedger + this.deps.ledgerWindowSize - 1;

    const fetchSpan = this.telemetry.startSpan("indexer.ingestion.fetch", {
      contractId: this.deps.contractId,
    });
    const { events, latestLedger } =
      await this.deps.eventFetcher.fetchByLedgerWindow({
        startLedger,
        endLedger: provisionalEnd,
      });
    fetchSpan.end({ eventCount: String(events.length) });

    // Track the latest network ledger for lag computation (Issue #713)
    if (latestLedger > 0) {
      this.metrics.setLatestNetworkLedgerSequence(latestLedger);
    }

    // ── Reorg detection ──────────────────────────────────────────────────
    // After fetching the events window, check whether the chain has undergone
    // a reorganisation by comparing the latest ledger sequence (and hash)
    // against the last known values.  A reorg is detected when:
    //   • The network's latest ledger sequence has decreased, OR
    //   • The sequence is the same but the hash differs.
    // On detection the cursor is rewound to a safe depth so that forked events
    // are re-fetched and the canonical chain state is re-indexed.
    if (latestLedger > 0 && this.lastKnownLatestLedger !== null) {
      const reorgDetected =
        latestLedger < this.lastKnownLatestLedger ||
        (latestLedger === this.lastKnownLatestLedger &&
          this.lastKnownLatestHash !== null &&
          this.lastKnownLatestHash !== (await this.fetchLatestLedgerHash()));

      if (reorgDetected) {
        const rewindLedgers =
          this.deps.ledgerWindowSize * REORG_REWIND_DEPTH_MULTIPLIER;
        const currentSeq = Number(this.cursor ?? 0);
        const safeSequence = Math.max(0, currentSeq - rewindLedgers);

        this.logger.warn("Chain reorganisation detected — rewinding cursor", {
          event: "indexer.reorg.detected",
          lastKnownLatestLedger: this.lastKnownLatestLedger,
          lastKnownLatestHash: this.lastKnownLatestHash,
          currentLatestLedger: latestLedger,
          cursorBefore: this.cursor,
          rewindLedgers,
          safeSequence,
        });

        this.metrics.setLatestIndexedLedgerSequence(safeSequence);
        this.lastKnownLatestLedger = latestLedger;

        return {
          nextCursor: String(safeSequence),
          lastIndexedLedgerSequence: safeSequence,
          batchWriteSucceeded: false,
        };
      }
    }

    // Update known ledger info after successful fetch
    if (latestLedger > 0) {
      this.lastKnownLatestLedger = latestLedger;
      try {
        const ledgerInfo = await this.deps.eventFetcher.getLatestLedgerInfo();
        this.lastKnownLatestHash = ledgerInfo.hash;
      } catch {
        // Non-fatal: hash tracking is best-effort for reorg detection
      }
    }

    if (startLedger > latestLedger) {
      return {
        nextCursor: currentCursor ?? String(safeCurrentSequence),
        lastIndexedLedgerSequence: safeCurrentSequence,
        batchWriteSucceeded: false,
      };
    }

    const endLedger = Math.min(provisionalEnd, latestLedger);

    // ── Cursor-level gap detection ────────────────────────────────────────
    // Check whether the high-water mark (the last successfully indexed ledger
    // sequence recorded in metrics) is contiguous with the batch start.
    // This detects cases where:
    //   - The cursor was manually advanced past unprocessed ledgers.
    //   - A previous run crashed between batch-write and checkpoint-flush,
    //     then the cursor was re-pointed forward.
    //   - Two consecutive ticks saw the startLedger jump non-contiguously.
    //
    // We use the metrics high-water mark (lastIndexedLedgerSequence) rather
    // than safeCurrentSequence because safeCurrentSequence == startLedger - 1
    // (always contiguous by construction), whereas the high-water mark
    // records the last *confirmed written* ledger across restarts.
    const lastConfirmedIndexed = this.metrics.getLatestIndexedLedgerSequence();

    if (
      lastConfirmedIndexed !== null &&
      lastConfirmedIndexed > 0 &&
      latestLedger > 0
    ) {
      const cursorGap = this.gapDetector.detectCursorGap(
        lastConfirmedIndexed,
        startLedger,
        latestLedger
      );
      if (cursorGap.gapDetected) {
        this.logger.warn(
          "Cursor-level ledger gap detected — starting backfill",
          {
            event: "indexer.gap.cursor_gap",
            lastIndexedLedger: lastConfirmedIndexed,
            batchStartLedger: startLedger,
            gapStartLedger: cursorGap.gapStartLedger,
            gapEndLedger: cursorGap.gapEndLedger,
            gapSize: cursorGap.gapSize,
          }
        );

        const backfillResult = await this.gapDetector.runBackfill(
          cursorGap.gapStartLedger!,
          cursorGap.gapEndLedger!
        );

        if (backfillResult.paused) {
          this.isPaused = true;
          return {
            nextCursor: currentCursor ?? String(safeCurrentSequence),
            lastIndexedLedgerSequence: safeCurrentSequence,
            batchWriteSucceeded: false,
          };
        }
      }
    }

    const parseSpan = this.telemetry.startSpan("indexer.ingestion.parse", {
      contractId: this.deps.contractId,
    });
    const { trades, errors: tradeErrors } = parseTradeEvents(events, {
      telemetry: this.telemetry,
    });
    const { resolutions, errors: resolutionErrors } = parseResolutionEvents(
      events,
      { telemetry: this.telemetry }
    );
    const { deposits, errors: depositErrors } = parseCollateralDepositedEvents(
      events,
      { telemetry: this.telemetry }
    );
    const { markets, errors: marketErrors } = parseMarketCreatedEvents(events, {
      telemetry: this.telemetry,
    });
    parseSpan.end({
      trades: String(trades.length),
      resolutions: String(resolutions.length),
      deposits: String(deposits.length),
      markets: String(markets.length),
    });

    for (const error of tradeErrors) {
      this.metrics.incrementParseError();
      this.logger.warn("Trade parse error — skipping event", {
        eventId: error.eventId,
        error: error.message,
        parseErrorType: TradeParseError.name,
      });
    }

    for (const error of resolutionErrors) {
      this.logger.warn("Resolution parse error — skipping event", {
        eventId: error.eventId,
        error: error.message,
        parseErrorType: ResolutionParseError.name,
      });
    }

    for (const error of depositErrors) {
      this.logger.warn("Collateral deposit parse error — skipping event", {
        eventId: error.eventId,
        error: error.message,
        parseErrorType: CollateralDepositedParseError.name,
      });
    }

    for (const error of marketErrors) {
      this.logger.warn("Market created parse error — skipping event", {
        eventId: error.eventId,
        error: error.message,
        parseErrorType: MarketCreatedParseError.name,
      });
    }

    // Log events that matched no known parser (Issue #712)
    const knownEventIds = new Set([
      ...tradeErrors.map((e) => e.eventId),
      ...trades.map((t) => t.eventId),
      ...resolutionErrors.map((e) => e.eventId),
      ...resolutions.map((r) => r.eventId),
      ...depositErrors.map((e) => e.eventId),
      ...deposits.map((d) => d.eventId),
      ...marketErrors.map((e) => e.eventId),
      ...markets.map((m) => m.eventId),
    ]);
    for (const event of events) {
      if (!knownEventIds.has(event.id)) {
        this.logger.warn("Unknown event type — no matching parser found", {
          eventId: event.id,
          ledger: event.ledger,
          topicsXdr: event.topicsXdr,
        });
      }
    }

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

    const writeSpan = this.telemetry.startSpan("indexer.ingestion.write", {
      contractId: this.deps.contractId,
    });
    const writeResult = await this.deps.batchWriter.write(records);
    writeSpan.end({
      written: String(writeResult.written),
      skipped: String(writeResult.skipped),
      errors: String(writeResult.errors.length),
    });

    if (writeResult.errors.length > 0) {
      this.logger.warn("Indexer batch write completed with errors", {
        startLedger,
        endLedger,
        writeErrors: writeResult.errors.length,
        written: writeResult.written,
        skipped: writeResult.skipped,
      });

      return {
        nextCursor: currentCursor ?? String(safeCurrentSequence),
        lastIndexedLedgerSequence: safeCurrentSequence,
        batchWriteSucceeded: false,
      };
    }

    // ── Within-window gap detection (after successful batch write) ────────
    // Note: Within-window detection (checking every ledger for events) is NOT
    // performed here because Stellar ledgers are commonly quiet (no contract
    // events) — absent event-ledgers within a fetched range are normal.
    // Operators wanting fine-grained per-ledger verification should use the
    // GapDetector.detectGap() API directly with an explicit seenLedgers set
    // constructed from domain-specific knowledge of expected event cadence.
    //
    // The cursor-level gap check (above, before the batch) is the durable
    // watermark signal for production alerting.

    this.logger.debug("Ingestion batch complete", {
      startLedger,
      endLedger,
      eventsFetched: events.length,
      marketsParsed: markets.length,
      tradesParsed: trades.length,
      resolutionsParsed: resolutions.length,
      collateralDepositsParsed: deposits.length,
      written: writeResult.written,
      skipped: writeResult.skipped,
      writeErrors: writeResult.errors.length,
    });

    return {
      nextCursor: String(endLedger),
      lastIndexedLedgerSequence: endLedger,
      batchWriteSucceeded: true,
    };
  }
}
