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
import { StellarTransport } from "../../../packages/shared/src/stellarTransport.js";

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
  private server: StellarRpc.Server;
  private readonly config: Required<EventFetcherConfig>;
  private readonly telemetry: Telemetry;
  private readonly transport: StellarTransport;
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
    this.telemetry = telemetry;

    // Initialize transport for multi-endpoint failover
    const horizonUrls = Array.isArray(this.config.rpcUrl)
      ? this.config.rpcUrl
      : [this.config.rpcUrl];

    const logger = {
      info: (msg: string, ctx?: any) =>
        telemetry.record("indexer.transport.info", 1, ctx || {}),
      warn: (msg: string, ctx?: any) =>
        telemetry.record("indexer.transport.warn", 1, ctx || {}),
      error: (msg: string, ctx?: any) =>
        telemetry.record("indexer.transport.error", 1, ctx || {}),
      debug: (msg: string, ctx?: any) =>
        telemetry.record("indexer.transport.debug", 1, ctx || {}),
      child: (_childPrefix: string) => logger,
    };

    this.transport = new StellarTransport(horizonUrls, logger, {
      timeoutMs: this.config.fetchTimeoutMs || DEFAULT_FETCH_TIMEOUT_MS,
    });

    this.server = new StellarRpc.Server(this.transport.getActiveEndpoint());
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
    // Soroban RPC getLatestLedger returns the ledger hash as `id`.
    return { sequence: info.sequence, hash: info.id };
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
   * Uses StellarTransport for multi-endpoint failover and circuit breaking.
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
            const response = await this.transport.execute(
              async (url: string) => {
                // Prefer an injected mock server (unit tests replace this.server
                // with a stub). In production, rebuild the RPC client whenever
                // transport fails over to a different endpoint URL.
                const isRealServer = this.server instanceof StellarRpc.Server;
                if (!this.server || isRealServer) {
                  this.server = new StellarRpc.Server(url);
                }
                const fetchCall = this.server.getEvents({
                  startLedger,
                  filters: [{ contractIds: [contractId] }],
                  limit: pageLimit,
                  ...(cursor ? ({ cursor } as any) : {}),
                } as any);

                // Wrap with a per-page timeout when fetchTimeoutMs > 0 so a
                // stalled RPC endpoint cannot block the ingestion loop
                // indefinitely. Always clear the timer when fetchCall settles
                // so a fast rejection cannot leave an unhandled timeout later.
                let result: StellarRpc.Api.GetEventsResponse;
                if (fetchTimeoutMs > 0) {
                  let timeoutId: ReturnType<typeof setTimeout> | undefined;
                  try {
                    result = await Promise.race([
                      fetchCall,
                      new Promise<never>((_, reject) => {
                        timeoutId = setTimeout(
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
                        );
                      }),
                    ]);
                  } finally {
                    if (timeoutId !== undefined) clearTimeout(timeoutId);
                  }
                } else {
                  result = await fetchCall;
                }

                return result;
              },
              "getEvents"
            );

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
