import { randomUUID } from "node:crypto";
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

/**
 * Maximum number of consecutive pages that may return the *same* paging
 * cursor before the fetch is declared stalled. A stalled cursor means the RPC
 * node is not making progress; continuing would loop forever and pin the
 * ingestion loop, so we fail closed instead.
 */
const MAX_STALL_ITERATIONS = 3;

/**
 * Stable error codes surfaced by the event fetcher. Callers can branch on
 * `code` without parsing messages, and ops can alert on them.
 */
export type EventFetcherErrorCode =
  "EVENT_FETCH_RETRIES_EXHAUSTED" | "EVENT_FETCH_NON_RETRYABLE";

/**
 * Fail-closed error thrown when the fetcher is constructed with an
 * unusable configuration (missing contract id / RPC endpoint, or a
 * non-positive page size). Refusing to construct is deliberate: a
 * misconfigured fetcher that silently defaults would index the wrong
 * contract, or fetch unbounded pages, on a money path.
 */
export class EventFetcherConfigError extends Error {
  readonly code = "EVENT_FETCHER_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "EventFetcherConfigError";
  }
}

/**
 * Fail-closed error thrown when the RPC node keeps handing back the same
 * paging cursor. Callers must treat this as "no data" rather than retrying
 * forever.
 */
export class CursorStallError extends Error {
  readonly code = "EVENT_FETCH_CURSOR_STALLED";
  readonly cursor: string;
  readonly iterations: number;

  constructor(cursor: string, iterations: number) {
    super(
      `Event fetch cursor stalled at ${cursor} after ${iterations} iteration(s)`
    );
    this.name = "CursorStallError";
    this.cursor = cursor;
    this.iterations = iterations;
  }
}

/**
 * Fail-closed error thrown when a page cannot be fetched. We never return
 * partial/empty results on failure so downstream settlement cannot act on
 * an incomplete view of chain state.
 */
export class EventFetcherError extends Error {
  readonly code: EventFetcherErrorCode;
  /**
   * Whether retrying the same page could plausibly succeed. Ops and
   * upstream callers branch on this instead of parsing messages: a
   * `true` value means the endpoint/chain is unhealthy, a `false` value
   * means the request itself is wrong and replaying it is futile.
   */
  readonly retryable: boolean;
  readonly attempts: number;
  readonly startLedger: number;
  readonly cursor?: string;
  readonly cause?: unknown;

  constructor(
    code: EventFetcherErrorCode,
    message: string,
    details: {
      attempts: number;
      startLedger: number;
      cursor?: string;
      cause?: unknown;
      /** Defaults to `true` (transient) — see {@link retryable}. */
      retryable?: boolean;
    }
  ) {
    super(message);
    this.name = "EventFetcherError";
    this.code = code;
    this.retryable =
      details.retryable ?? code === "EVENT_FETCH_RETRIES_EXHAUSTED";
    this.attempts = details.attempts;
    this.startLedger = details.startLedger;
    this.cursor = details.cursor;
    this.cause = details.cause;
  }
}

/**
 * The fetcher configuration after defaults are applied. `rpcUrl` stays
 * optional at the type level because the caller may omit it, but
 * {@link assertValidConfig} rejects that before any request is made.
 */
type ResolvedEventFetcherConfig = Required<Omit<EventFetcherConfig, "rpcUrl">> &
  Pick<EventFetcherConfig, "rpcUrl">;

/**
 * Fail-closed validation of the resolved fetcher configuration. Throws
 * {@link EventFetcherConfigError} rather than defaulting, so a bad deploy
 * fails at boot instead of quietly indexing nothing (or the wrong stream).
 */
function assertValidConfig(config: ResolvedEventFetcherConfig): void {
  if (typeof config.contractId !== "string" || config.contractId.length === 0) {
    throw new EventFetcherConfigError("contractId must be a non-empty string");
  }

  const endpoints = Array.isArray(config.rpcUrl)
    ? config.rpcUrl
    : [config.rpcUrl];
  if (
    endpoints.length === 0 ||
    endpoints.some((url) => typeof url !== "string" || url.trim().length === 0)
  ) {
    throw new EventFetcherConfigError(
      "rpcUrl must resolve to at least one endpoint"
    );
  }

  if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0) {
    throw new EventFetcherConfigError(
      "maxRetries must be a non-negative integer"
    );
  }

  if (!Number.isFinite(config.retryDelayMs) || config.retryDelayMs < 0) {
    throw new EventFetcherConfigError(
      "retryDelayMs must be a non-negative number"
    );
  }

  if (!Number.isInteger(config.pageLimit) || config.pageLimit < 1) {
    throw new EventFetcherConfigError("pageLimit must be an integer >= 1");
  }

  if (!Number.isFinite(config.fetchTimeoutMs) || config.fetchTimeoutMs < 0) {
    throw new EventFetcherConfigError(
      "fetchTimeoutMs must be a non-negative number"
    );
  }
}

export class EventFetcher {
  private server: StellarRpc.Server;
  private readonly config: ResolvedEventFetcherConfig;
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

    // Fail-closed configuration gate. A fetcher that silently defaults a
    // missing contract id or a non-positive page size would index the
    // wrong stream, or ask the RPC for an unbounded page, on a money path
    // — so refuse to construct instead.
    assertValidConfig(this.config);

    // Initialize transport for multi-endpoint failover. assertValidConfig()
    // above has already rejected a missing/blank endpoint, so the resolved
    // list is guaranteed non-empty here.
    const horizonUrls: string[] = Array.isArray(this.config.rpcUrl)
      ? this.config.rpcUrl
      : [this.config.rpcUrl as string];

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
   *
   * Fail-closed: if any page cannot be fetched after retries, throws an
   * `EventFetcherError` instead of returning a partial result.
   *
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

    const requestId = randomUUID();

    const allEvents: RawChainEvent[] = [];
    let cursor: string | undefined;
    let latestLedger = 0;
    let previousCursor: string | undefined;
    let stallIterations = 0;

    do {
      const page = await this.fetchPageWithRetry(
        startLedger,
        requestId,
        cursor
      );
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

      if (cursor !== undefined && cursor === previousCursor) {
        stallIterations += 1;
        if (stallIterations >= MAX_STALL_ITERATIONS) {
          this.telemetry.record("indexer.rpc.cursor_stalled", 1, {
            requestId,
            cursor: cursor ?? "none",
          });
          throw new CursorStallError(cursor, stallIterations);
        }
      } else {
        stallIterations = 0;
      }
      previousCursor = cursor;
    } while (cursor !== undefined);

    this.telemetry.record("indexer.events.fetched", allEvents.length, {
      startLedger: String(startLedger),
      endLedger: String(endLedger),
      requestId,
    });

    return { events: allEvents, latestLedger };
  }

  /**
   * Fetch a single page, retrying transient RPC failures with the shared
   * jittered-backoff policy in retry.ts (bounded by config.maxRetries).
   * Uses StellarTransport for multi-endpoint failover and circuit breaking.
   *
   * Fail-closed: a page that cannot be fetched is never reported as an empty
   * page. The failure is mapped onto a stable {@link EventFetcherError} whose
   * `code` and `retryable` flags let callers and alerts branch without
   * parsing messages. The underlying cause is appended to the message (and
   * kept on `cause`) so operators still see the socket/DNS/timeout detail.
   */
  private async fetchPageWithRetry(
    startLedger: number,
    requestId: string,
    cursor?: string
  ): Promise<StellarRpc.Api.GetEventsResponse> {
    const { maxRetries, retryDelayMs, pageLimit, contractId, fetchTimeoutMs } =
      this.config;

    let attempt = 0;
    // The last error observed *inside* the retry callback. StellarTransport
    // aggregates endpoint failures into a generic "All N endpoints exhausted"
    // Error when it runs out of endpoints, which loses both the original
    // cause and its transient/permanent classification. Remembering the raw
    // error here keeps `EventFetcherError.code`/`retryable` honest — a
    // network blip must not be reported as a non-retryable client error.
    let lastObservedError: unknown = null;

    try {
      return await withRetry(
        async () => {
          attempt += 1;
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
            lastObservedError = err;
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
      // withRetry has already exhausted the budget (or gave up on a fatal
      // error). Classify once more so the surfaced code stays stable, and
      // always surface the cause — an operator triaging a stalled indexer
      // needs the socket/DNS/timeout detail, not just "retries exhausted".
      const cause = lastObservedError ?? err;
      const transient = isTransientError(cause);
      const code: EventFetcherErrorCode = transient
        ? "EVENT_FETCH_RETRIES_EXHAUSTED"
        : "EVENT_FETCH_NON_RETRYABLE";
      const causeMessage =
        cause instanceof Error ? cause.message : String(cause);

      this.telemetry.record("indexer.rpc.error", 1, {
        attempt: String(attempt),
        transient: String(transient),
        code,
      });

      throw new EventFetcherError(
        code,
        transient
          ? `Event fetch exhausted ${attempt} attempt(s) for ledger ${startLedger}: ${causeMessage}`
          : `Event fetch failed with non-retryable error for ledger ${startLedger}: ${causeMessage}`,
        {
          attempts: attempt,
          startLedger,
          cursor,
          cause,
          retryable: transient,
        }
      );
    }
  }

  private toRawEvent(e: StellarRpc.Api.EventResponse): RawChainEvent {
    const id = e.id;
    // Event id format: "{ledger(10d)}-{txIndex(10d)}-{eventIndex(10d)}"
    const idParts = id.split("-");
    const eventIndex = idParts.length === 3 ? parseInt(idParts[2], 10) : 0;

    return {
      id,
      ledger: (e as any).ledger as number,
      ledgerClosedAt: (e as any).ledgerClosedAt as string,
      contractId: (e as any).contractId as string,
      type: e.type,
      pagingToken: (e as any).pagingToken as string,
      eventIndex,
      valueXdr: (e as any).value.xdr as string,
      topicsXdr: (e as any).topic.map((t: any) => t.xdr) as string[],
    };
  }
}
