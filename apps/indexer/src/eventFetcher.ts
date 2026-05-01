import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import type {
  EventFetcherConfig,
  FetchEventsResult,
  LedgerWindow,
  RawChainEvent,
} from "./types.js";
import type { Telemetry } from "./telemetry.js";
import { consoleTelemetry } from "./telemetry.js";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_PAGE_LIMIT = 100;

const TRANSIENT_ERRORS = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "socket hang up",
]);

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    TRANSIENT_ERRORS.has((err as NodeJS.ErrnoException).code ?? "") ||
    TRANSIENT_ERRORS.has(err.message)
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
          ...(cursor ? { cursor } : {}),
        });

        this.telemetry.record(
          "indexer.rpc.page_fetched",
          response.events.length,
          {
            attempt: String(attempt),
          }
        );

        return response;
      } catch (err) {
        const isLast = attempt === maxRetries;
        if (isLast || !isTransient(err)) {
          this.telemetry.record("indexer.rpc.error", 1, {
            attempt: String(attempt),
            transient: String(isTransient(err)),
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
      contractId: e.contractId,
      type: e.type,
      pagingToken: (e as any).pagingToken as string,
      valueXdr: e.value.xdr,
      topicsXdr: e.topic.map((t) => t.xdr),
    };
  }
}
