import type { Trade } from "../matching/engine.js";

export interface IndexerEvent {
  /** Unique event ID — used for deduplication */
  id: string;
  /** Ledger sequence number the event originated from */
  ledgerSequence: number;
  trade: Trade;
}

export interface ProcessResult {
  processed: number;
  duplicates: number;
  failed: number;
}

/**
 * Processes batches of indexer events with idempotency guarantees.
 * Duplicate events (same event ID) are detected and skipped without
 * mutating state, ensuring ledger replays are safe.
 */
export class EventProcessor {
  private readonly seenEventIds = new Set<string>();
  private duplicateCount = 0;

  /**
   * Process a batch of events. Duplicates are skipped and counted.
   * Processing always continues past duplicates.
   *
   * @param events - Batch of indexer events to process
   * @param handler - Async function called for each new (non-duplicate) event
   * @returns Summary of processed, duplicate, and failed event counts
   */
  async processBatch(
    events: IndexerEvent[],
    handler: (event: IndexerEvent) => Promise<void>
  ): Promise<ProcessResult> {
    let processed = 0;
    let duplicates = 0;
    let failed = 0;

    for (const event of events) {
      if (this.seenEventIds.has(event.id)) {
        duplicates++;
        this.duplicateCount++;
        console.warn(
          `[EventProcessor] Duplicate event detected: id=${event.id} ledger=${event.ledgerSequence}`
        );
        continue;
      }

      try {
        await handler(event);
        this.seenEventIds.add(event.id);
        processed++;
      } catch (err) {
        failed++;
        console.error(
          `[EventProcessor] Failed to process event ${event.id}:`,
          err
        );
      }
    }

    return { processed, duplicates, failed };
  }

  /** Total duplicate events seen across all batches */
  getTotalDuplicates(): number {
    return this.duplicateCount;
  }

  /** Number of unique event IDs seen so far */
  getSeenCount(): number {
    return this.seenEventIds.size;
  }

  /** Reset state (useful between ledger replay tests) */
  reset(): void {
    this.seenEventIds.clear();
    this.duplicateCount = 0;
  }
}
