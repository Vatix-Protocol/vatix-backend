import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import type {
  EventFetcherConfig,
  FetchEventsResult,
  LedgerWindow,
  RawChainEvent,
} from "./types.js";
import type { Telemetry } from "./telemetry.js";
import { consoleTelemetry } from "./telemetry.js";
import { isTransientError, sleep, withRetry } from "./retry.js";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_PAGE_LIMIT = 100;
/**
 * Default per-page RPC fetch timeout (ms). A single getEvents call that
 * hangs longer than this is aborted and treated as a transient failure so
 * the retry/backoff logic can take over.  Set fetchTimeoutMs: 0 to disable.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

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
      fetchTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
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
   * Returns the sequence number and hash of the latest ledger from the RPC node.
   * Used by the ingestion loop to detect chain reorganisations.
   */
  async getLatestLedgerInfo(): Promise<{ sequence: number; hash: string }> {
    const info = await this.server.getLatestLedger();
    return { sequence: info.sequence, hash: info.hash.id };
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

  /**
   * Fetch a single page, retrying transient RPC failures with the shared
   * jittered-backoff policy in retry.ts (bounded by config.maxRetries).
   */
  private async fetchPageWithRetry(
    startLedger: number,
    cursor?: string
  ): Promise<StellarRpc.Api.GetEventsResponse> {
    const { maxRetries, retryDelayMs, pageLimit, contractId, fetchTimeoutMs } =
      this.config;

    let attempt = -1;

    try {
      return await withRetry(
        async () => {
          attempt++;
          try {
            const fetchCall = this.server.getEvents({
              startLedger,
              filters: [{ contractIds: [contractId] }],
              limit: pageLimit,
              ...(cursor ? ({ cursor } as any) : {}),
            } as any);

            // Wrap with a per-page timeout when fetchTimeoutMs > 0 so a
            // stalled RPC endpoint cannot block the ingestion loop
            // indefinitely.
            const response: StellarRpc.Api.GetEventsResponse =
              fetchTimeoutMs > 0
                ? await Promise.race([
                    fetchCall,
                    new Promise<never>((_, reject) =>
                      setTimeout(
                        () =>
                          reject(
                            Object.assign(
                              new Error(
                                `EventFetcher: getEvents timed out after ${fetchTimeoutMs}ms`
                              ),
                              { code: "ETIMEDOUT" }
                            )
                          ),
                        fetchTimeoutMs
                      )
                    ),
                  ])
                : await fetchCall;

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
            if (isTransientError(err)) {
              this.consecutiveDisconnections++;
              this.telemetry.record("indexer.rpc.disconnection", 1, {
                consecutive: String(this.consecutiveDisconnections),
              });
            }
            throw err;
          }
        },
        { maxRetries, retryDelayMs }
      );
    } catch (err) {
      this.telemetry.record("indexer.rpc.error", 1, {
        attempt: String(attempt),
        transient: String(isTransientError(err)),
      });
      throw err;
    }
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
