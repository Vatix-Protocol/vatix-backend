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
 * Stable error codes surfaced by the event fetcher. Callers can branch on
 * `code` without parsing messages, and ops can alert on them.
 */
export type EventFetcherErrorCode =
  | "EVENT_FETCH_RETRIES_EXHAUSTED"
  | "EVENT_FETCH_NON_RETRYABLE";

/**
 * Fail-closed error thrown when a page cannot be fetched. We never return
 * partial/empty results on failure so downstream settlement cannot act on
 * an incomplete view of chain state.
 */
export class EventFetcherError extends Error {
  readonly code: EventFetcherErrorCode;
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
    }
  ) {
    super(message);
    this.name = "EventFetcherError";
    this.code = code;
    this.attempts = details.attempts;
    this.startLedger = details.startLedger;
    this.cursor = details.cursor;
    this.cause = details.cause;
  }
}

export class EventFetcher {
  private readonly server: StellarRpc.Server;
  private readonly config: Required<EventFetcherConfig>;
  private readonly telemetry: Telemetry;

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
   * Fetch all raw chain events within [startLedger, endLedger].
   * Handles multi-page responses and retries on transient failures.
   *
   * Fail-closed: if any page cannot be fetched after retries, throws an
   * `EventFetcherError` instead of returning a partial result.
   */
  async fetchByLedgerWindow(window: LedgerWindow): Promise<FetchEventsResult> {
    const { startLedger, endLedger } = window;
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

        this.telemetry.record(
          "indexer.rpc.page_fetched",
          response.events.length,
          {
            attempt: String(attempt),
          }
        );

        return response;
      } catch (err) {
        const transient = isTransientError(err);
        const isLast = attempt === maxRetries;

        if (isLast || !transient) {
          const code: EventFetcherErrorCode = transient
            ? "EVENT_FETCH_RETRIES_EXHAUSTED"
            : "EVENT_FETCH_NON_RETRYABLE";

          this.telemetry.record("indexer.rpc.error", 1, {
            attempt: String(attempt),
            transient: String(transient),
            code,
          });

          throw new EventFetcherError(
            code,
            transient
              ? `Event fetch exhausted ${maxRetries + 1} attempts for ledger ${startLedger}`
              : `Event fetch failed with non-retryable error for ledger ${startLedger}`,
            { attempts: attempt + 1, startLedger, cursor, cause: err }
          );
        }

        const delay = retryDelayMs * 2 ** attempt;
        this.telemetry.record("indexer.rpc.retry", 1, {
          attempt: String(attempt),
          delayMs: String(delay),
        });
        console.warn(
          `[EventFetcher] transient error (attempt ${attempt + 1}), retrying in ${delay}ms`,
          err
        );
        await sleep(delay);
      }
    }

    // Unreachable — satisfies TypeScript
    throw new EventFetcherError(
      "EVENT_FETCH_RETRIES_EXHAUSTED",
      `Event fetch exhausted retries for ledger ${startLedger}`,
      { attempts: maxRetries + 1, startLedger, cursor }
    );
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
