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
 * Delivery semantics of {@link EventProcessor} (#980).
 *
 * The processor is **at-least-once**: an event may be handed to the handler
 * more than once, so handlers MUST be idempotent. It is never "exactly-once"
 * at the delivery layer.
 */
export type DeliverySemantics = "at-least-once";

/** @see DeliverySemantics */
export const DELIVERY_SEMANTICS: DeliverySemantics = "at-least-once";

/**
 * Durable idempotency store (#980). When supplied, event IDs are checked
 * against — and recorded in — a persistent store (e.g. a Postgres table with
 * a UNIQUE constraint on the event ID) in addition to the in-memory window.
 * This is what makes exactly-once *effects* achievable on top of
 * at-least-once *delivery*: duplicates that survive a restart or an
 * in-memory eviction are still caught before the handler runs.
 *
 * Methods may be sync or async.
 */
export interface EventDedupStore {
  /** True when this event ID has already been durably processed. */
  has(eventId: string): Promise<boolean> | boolean;
  /** Durably record this event ID as processed. */
  add(eventId: string): Promise<void> | void;
}

export interface EventProcessorOptions {
  /** Cap on tracked event IDs in the in-memory window before eviction. */
  maxSeenEventIds?: number;
  /** Durable idempotency store — required for exactly-once effects in prod. */
  persistentStore?: EventDedupStore;
  /**
   * Environment map used for the production readiness check (default:
   * process.env). Injectable for tests.
   */
  env?: Record<string, string | undefined>;
}

/** Default cap on tracked event IDs before the oldest are evicted. */
const DEFAULT_MAX_SEEN_EVENT_IDS = 100_000;

/**
 * Processes batches of indexer events with **at-least-once** delivery and
 * idempotency guards.
 *
 * ## Delivery semantics (#980)
 *
 * - Delivery is **at-least-once**. The same event ID can be handed to the
 *   handler again after a process restart (the in-memory window is not
 *   persisted) or after the oldest IDs are evicted from the bounded window.
 *   Ledger reorgs / replays also re-deliver events.
 * - Handlers MUST therefore be **idempotent**. For example, writing a
 *   `ResolutionCandidate` must be an upsert / guarded by a UNIQUE constraint,
 *   never a blind `INSERT` — otherwise a redelivered event produces a
 *   duplicate `ResolutionCandidate`.
 * - The in-memory `seenEventIds` set is a **best-effort fast-path** dedup for
 *   recent replays only. It is NOT the source of truth.
 * - The **source of truth for exactly-once effects** is a durable store: pass
 *   an {@link EventDedupStore} via {@link EventProcessorOptions.persistentStore}
 *   (backed by a DB UNIQUE constraint on the event ID). In
 *   `NODE_ENV=production` a processor constructed without one logs a warning.
 *
 * See `docs/event-processor.md` for the full contract and operator guidance.
 */
export class EventProcessor {
  private readonly seenEventIds = new Set<string>();
  private readonly maxSeenEventIds: number;
  private readonly persistentStore?: EventDedupStore;
  private duplicateCount = 0;

  /**
   * @param maxSeenEventIds - cap on the in-memory window, OR an options
   *   object. The bare-number form is kept for backwards compatibility.
   * @param options - additional options when the first arg is a number.
   */
  constructor(
    maxSeenEventIds:
      number | EventProcessorOptions = DEFAULT_MAX_SEEN_EVENT_IDS,
    options: EventProcessorOptions = {}
  ) {
    const opts: EventProcessorOptions =
      typeof maxSeenEventIds === "number"
        ? { ...options, maxSeenEventIds }
        : maxSeenEventIds;

    this.maxSeenEventIds = opts.maxSeenEventIds ?? DEFAULT_MAX_SEEN_EVENT_IDS;
    this.persistentStore = opts.persistentStore;

    const env = opts.env ?? process.env;
    if (env.NODE_ENV === "production" && !this.persistentStore) {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          message:
            "EventProcessor constructed without a persistent dedup store in production; " +
            "delivery is at-least-once and exactly-once effects are NOT guaranteed. " +
            "Handlers must be idempotent (see docs/event-processor.md).",
          component: "event-processor",
          deliverySemantics: DELIVERY_SEMANTICS,
        })
      );
    }
  }

  /** Delivery guarantee this processor provides. Always `"at-least-once"`. */
  getDeliverySemantics(): DeliverySemantics {
    return DELIVERY_SEMANTICS;
  }

  /** Whether a durable idempotency store is wired up. */
  hasPersistentStore(): boolean {
    return Boolean(this.persistentStore);
  }

  /**
   * Process a batch of events. Duplicates are skipped and counted.
   * Processing always continues past duplicates.
   *
   * A given event ID is treated as a duplicate when it is present in the
   * in-memory window OR (when a persistent store is configured) already
   * recorded there. An event is recorded in both only after its handler
   * resolves successfully, so a failed handler leaves the event eligible for
   * redelivery.
   *
   * @param events - Batch of indexer events to process
   * @param handler - Async function called for each new (non-duplicate) event
   * @param correlationId - optional id threaded into duplicate/failure logs
   * @returns Summary of processed, duplicate, and failed event counts
   */
  async processBatch(
    events: IndexerEvent[],
    handler: (event: IndexerEvent) => Promise<void>,
    correlationId?: string
  ): Promise<ProcessResult> {
    let processed = 0;
    let duplicates = 0;
    let failed = 0;

    for (const event of events) {
      const isDuplicate =
        this.seenEventIds.has(event.id) ||
        (this.persistentStore
          ? await this.persistentStore.has(event.id)
          : false);

      if (isDuplicate) {
        duplicates++;
        this.duplicateCount++;
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            message: "Duplicate event detected",
            component: "event-processor",
            eventId: event.id,
            ledgerSequence: event.ledgerSequence,
            deliverySemantics: DELIVERY_SEMANTICS,
            ...(correlationId ? { correlationId } : {}),
          })
        );
        // Backfill the in-memory window from the durable store so subsequent
        // checks in this run stay on the fast path.
        this.markSeen(event.id);
        continue;
      }

      try {
        await handler(event);
        this.markSeen(event.id);
        if (this.persistentStore) {
          await this.persistentStore.add(event.id);
        }
        processed++;
      } catch (err) {
        failed++;
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            message: "Failed to process event",
            component: "event-processor",
            eventId: event.id,
            ledgerSequence: event.ledgerSequence,
            error: err instanceof Error ? err.message : String(err),
            ...(correlationId ? { correlationId } : {}),
          })
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

  /**
   * Record an event ID as seen, evicting the oldest tracked ID first if the
   * set is at capacity. `Set` iteration order is insertion order, so the
   * first value is always the oldest.
   */
  private markSeen(id: string): void {
    if (this.seenEventIds.has(id)) return;
    if (this.seenEventIds.size >= this.maxSeenEventIds) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) {
        this.seenEventIds.delete(oldest);
      }
    }
    this.seenEventIds.add(id);
  }
}
