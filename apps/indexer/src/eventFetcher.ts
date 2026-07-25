import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import type {
  EventFetcherConfig,
  FetchEventsResult,
  LedgerWindow,
  RawChainEvent,
} from "./types.js";
import type { Telemetry } from "./telemetry.js";
import { consoleTelemetry } from "./telemetry.js";
import { isTransientError, sleep } from "./retry.js";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_PAGE_LIMIT = 100;

/**
 * Maximum consecutive RPC failures before the fetcher enters a disconnected
 * state. Once disconnected, the fetcher applies a longer backoff to allow
 * the RPC endpoint to recover before the next attempt.
 */
const MAX_CONSECUTIVE_DISCONNECTIONS = 5;

/**
 * Backoff delay (ms) applied when the fetcher has been consecutively
 * disconnected for MAX_CONSECUTIVE_DISCONNECTIONS or more attempts.
 * This is longer than the per-page retry delay to avoid hammering a
 * downed RPC endpoint.
 */
const DISCONNECTED_BACKOFF_MS = 10_000;

export class EventFetcher {
  private readonly server: StellarRpc.Server;
  private readonly config: Required<EventFetcherConfig>;
  private readonly telemetry: Telemetry;
  /** Tracks consecutive RPC failures to detect sustained disconnect. */
  private consecutiveDisconnections = 0;

  constructor(
    config: EventFetcherConfig,
    telemetry: Telemetry = consoleTelemetry
  ) {
    this.config = {
      maxRetries: DEFAULT_MAX_RETRIES,
      retryDelayMs: DEFAULT_RETRY_DELAY_MS,
      pageLimit: DEFAULT_PAGE_LIMIT,
      ...config,
    };
    this.server = new StellarRpc.Server(this.config.rpcUrl);
    this.telemetry = telemetry;
  }

  /**
   * Returns the current consecutive RPC disconnection count for
   * observability / health-check surfaces.
   */
  getConsecutiveDisconnections(): number {
    return this.consecutiveDisconnections;
  }

  /**
   * Fetch all raw chain events within [startLedger, endLedger].
   * Handles multi-page responses and retries on transient failures.
   * Applies an extended ingestion backoff when the RPC endpoint has been
   * consecutively unreachable (Issue #710).
   */
  async fetchByLedgerWindow(window: LedgerWindow): Promise<FetchEventsResult> {
    const { startLedger, endLedger } = window;

    // If we have been consecutively disconnected too many times, apply a
    // longer backoff delay before the next attempt to avoid hammering a
    // downed RPC endpoint.
    if (this.consecutiveDisconnections >= MAX_CONSECUTIVE_DISCONNECTIONS) {
      this.telemetry.record("indexer.rpc.disconnected_backoff", 1, {
        consecutiveDisconnections: String(this.consecutiveDisconnections),
        backoffMs: String(DISCONNECTED_BACKOFF_MS),
      });
      await sleep(DISCONNECTED_BACKOFF_MS);
    }

    const allEvents: RawChainEvent[] = [];
    let cursor: string | undefined;
    let latestLedger = 0;

    do {
      const page = await this.fetchPageWithRetry(startLedger, cursor);
      latestLedger = page.latestLedger;

      const inWindow = page.events.filter((e) => {
        const seq = (e as any).ledger as number;
        return seq >= startLedger && seq <= endLedger;
      });

      for (const raw of inWindow) {
        allEvents.push(this.toRawEvent(raw));
      }

      // Advance cursor only when a full page was returned and we haven't passed endLedger
      const last = page.events[page.events.length - 1];
      const lastLedger = last
        ? ((last as any).ledger as number)
        : endLedger + 1;
      const fullPage = page.events.length >= this.config.pageLimit;

      cursor =
        fullPage && last && lastLedger <= endLedger
          ? (last as any).pagingToken
          : undefined;
    } while (cursor !== undefined);

    this.telemetry.record("indexer.events.fetched", allEvents.length, {
      startLedger: String(startLedger),
      endLedger: String(endLedger),
    });

    return { events: allEvents, latestLedger };
  }

  private async fetchPageWithRetry(
    startLedger: number,
    cursor?: string
  ): Promise<StellarRpc.Api.GetEventsResponse> {
    const { maxRetries, retryDelayMs, pageLimit, contractId } = this.config;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.server.getEvents({
          startLedger,
          filters: [{ contractIds: [contractId] }],
          limit: pageLimit,
          ...(cursor ? ({ cursor } as any) : {}),
        } as any);

        // Success — reset the consecutive disconnection counter
        this.consecutiveDisconnections = 0;

        this.telemetry.record(
          "indexer.rpc.page_fetched",
          response.events.length,
          {
            attempt: String(attempt),
          }
        );

        return response;
      } catch (err) {
        const isTransient = isTransientError(err);
        const isLast = attempt === maxRetries;

        if (isTransient) {
          this.consecutiveDisconnections++;
          this.telemetry.record("indexer.rpc.disconnection", 1, {
            consecutive: String(this.consecutiveDisconnections),
          });
        }

        if (isLast || !isTransient) {
          this.telemetry.record("indexer.rpc.error", 1, {
            attempt: String(attempt),
            transient: String(isTransient),
          });
          throw err;
        }

        const delay = retryDelayMs * 2 ** attempt;
        console.warn(
          `[EventFetcher] transient error (attempt ${attempt + 1}), retrying in ${delay}ms`,
          err
        );
        await sleep(delay);
      }
    }

    // Unreachable — satisfies TypeScript
    throw new Error("fetchPageWithRetry: exhausted retries");
  }

  private toRawEvent(e: StellarRpc.Api.EventResponse): RawChainEvent {
    return {
      id: e.id,
      ledger: (e as any).ledger as number,
      ledgerClosedAt: (e as any).ledgerClosedAt as string,
      contractId: (e as any).contractId as string,
      type: e.type,
      pagingToken: (e as any).pagingToken as string,
      valueXdr: (e as any).value.xdr as string,
      topicsXdr: (e as any).topic.map((t: any) => t.xdr) as string[],
    };
  }
}
