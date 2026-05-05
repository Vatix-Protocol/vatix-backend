import type { Logger } from "./logger.js";
import type { CursorStorageClient } from "./storage.js";
import type { InternalIndexerMetricsService } from "./metrics.js";

export interface IngestionLoop {
  start(initialCursor: string | null): Promise<void>;
  stop(): Promise<void>;
}

interface IngestionBatchResult {
  nextCursor: string;
  lastIndexedLedgerSequence: number;
}

const HEARTBEAT_INTERVAL_MS = 60_000;

export class PollingIngestionLoop implements IngestionLoop {
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isTickInProgress = false;
  private cursor: string | null = null;
  private successfulBatchesSinceLastCheckpoint = 0;
  private batchesSinceLastHeartbeat = 0;
  private lastHeartbeatLedgerSequence: number | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly storage: CursorStorageClient,
    private readonly metrics: InternalIndexerMetricsService,
    private readonly intervalMs: number,
    private readonly checkpointFlushEveryBatches: number
  ) {}

  async start(initialCursor: string | null): Promise<void> {
    this.cursor = initialCursor;
    const initialLedger = initialCursor ? Number(initialCursor) : null;
    if (initialLedger !== null && Number.isFinite(initialLedger)) {
      this.metrics.setLatestIndexedLedgerSequence(initialLedger);
    }

    this.logger.info("Indexer ingestion loop starting", {
      startCursor: initialCursor,
      intervalMs: this.intervalMs,
      checkpointFlushEveryBatches: this.checkpointFlushEveryBatches,
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

    await this.flushCheckpoint(true);

    this.logger.info("Indexer ingestion loop stopped", {
      finalCursor: this.cursor,
      latestIndexedLedgerSequence:
        this.metrics.getLatestIndexedLedgerSequence(),
    });
  }

  private async tick(): Promise<void> {
    if (this.isTickInProgress) {
      this.logger.warn(
        "Skipping ingestion tick because previous tick is active"
      );
      return;
    }

    this.isTickInProgress = true;

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
    }
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
      cursor: this.cursor,
      latestIndexedLedgerSequence,
      batchesProcessed: this.batchesSinceLastHeartbeat,
      ledgerDelta,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    });

    this.batchesSinceLastHeartbeat = 0;
    this.lastHeartbeatLedgerSequence = latestIndexedLedgerSequence;
  }

  private async ingestFromCursor(
    currentCursor: string | null
  ): Promise<IngestionBatchResult> {
    this.logger.debug("Running ingestion tick", { cursor: currentCursor });

    // Placeholder for source ingestion. Simulate successful batch progression.
    const currentSequence = currentCursor ? Number(currentCursor) : 0;
    const safeCurrentSequence =
      Number.isFinite(currentSequence) && currentSequence >= 0
        ? currentSequence
        : 0;
    const nextSequence = safeCurrentSequence + 1;

    return {
      nextCursor: String(nextSequence),
      lastIndexedLedgerSequence: nextSequence,
    };
  }
}
