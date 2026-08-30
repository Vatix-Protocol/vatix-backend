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
import { isTransientError, sleep } from "./retry.js";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_RATE_LIMIT_DELAY_MS = 1000;
const MAX_STALL_ITERATIONS = 3;

/** Thrown when the production event-fetcher path is misconfigured. Fail fast, no silent fallback. */
export class EventFetcherConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventFetcherConfigError";
  }
}

/** Thrown when Horizon/RPC keeps returning the same cursor and the loop cannot make progress. */
export class CursorStallError extends Error {
  constructor(cursor: string | undefined, iterations: number) {
    super(
      `EventFetcher: cursor did not advance after ${iterations} iterations (cursor=${cursor ?? "none"})`
    );
    this.name = "CursorStallError";
  }
}

function extractStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const anyErr = err as Record<string, unknown>;
  const status =
    anyErr.status ?? anyErr.statusCode ?? (anyErr.response as any)?.status;
  return typeof status === "number" ? status : undefined;
}

function isRateLimited(err: unknown): boolean {
  return extractStatusCode(err) === 429;
}

function extractRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const headers = (err as Record<string, any>).response?.headers;
  const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
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

    if (process.env.NODE_ENV === "production") {
      if (!this.config.rpcUrl || !this.config.rpcUrl.startsWith("https://")) {
        throw new EventFetcherConfigError(
          "EventFetcher requires an https:// rpcUrl in production; refusing to fall back to an insecure/local RPC endpoint"
        );
      }
      if (!this.config.contractId) {
        throw new EventFetcherConfigError(
          "EventFetcher requires contractId in production; refusing to poll all contracts silently"
        );
      }
    }

    this.server = new StellarRpc.Server(this.config.rpcUrl);
    this.telemetry = telemetry;
  }

  /**
   * Fetch all raw chain events within [startLedger, endLedger].
   * Handles multi-page responses and retries on transient failures.
   */
  async fetchByLedgerWindow(window: LedgerWindow): Promise<FetchEventsResult> {
    const { startLedger, endLedger } = window;
    const requestId = randomUUID();
    const allEvents: RawChainEvent[] = [];
    let cursor: string | undefined;
    let latestLedger = 0;
    let previousCursor: string | undefined;
    let stallIterations = 0;

    do {
      const page = await this.fetchPageWithRetry(startLedger, requestId, cursor);
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

  private async fetchPageWithRetry(
    startLedger: number,
    requestId: string,
    cursor?: string
  ): Promise<StellarRpc.Api.GetEventsResponse> {
    const { maxRetries, retryDelayMs, pageLimit, contractId } = this.config;
    let rateLimitAttempts = 0;

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
            requestId,
          }
        );

        return response;
      } catch (err) {
        if (isRateLimited(err)) {
          if (rateLimitAttempts >= DEFAULT_MAX_RATE_LIMIT_RETRIES) {
            this.telemetry.record("indexer.rpc.rate_limited_exhausted", 1, {
              requestId,
            });
            throw err;
          }
          rateLimitAttempts += 1;
          const retryAfterMs =
            extractRetryAfterMs(err) ??
            DEFAULT_RATE_LIMIT_DELAY_MS * 2 ** rateLimitAttempts;
          this.telemetry.record("indexer.rpc.rate_limited", 1, {
            requestId,
            attempt: String(rateLimitAttempts),
            delayMs: String(retryAfterMs),
          });
          await sleep(retryAfterMs);
          // Rate-limit backoff does not consume a normal retry attempt.
          attempt -= 1;
          continue;
        }

        const isLast = attempt === maxRetries;
        if (isLast || !isTransientError(err)) {
          this.telemetry.record("indexer.rpc.error", 1, {
            attempt: String(attempt),
            transient: String(isTransientError(err)),
            requestId,
          });
          throw err;
        }

        const delay = retryDelayMs * 2 ** attempt;
        console.warn(
          `[EventFetcher] transient error (attempt ${attempt + 1}), retrying in ${delay}ms (requestId=${requestId})`,
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
