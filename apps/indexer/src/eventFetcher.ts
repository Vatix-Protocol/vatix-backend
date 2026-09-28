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
import {
  RetryExhaustedError,
  isTransientError,
  sleep,
  withRetry,
} from "./retry.js";
import { StellarTransport } from "../../../packages/shared/src/stellarTransport.js";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_PAGE_LIMIT = 100;
/** Soroban RPC rejects `getEvents` requests with a larger `limit`. */
const MAX_PAGE_LIMIT = 10_000;
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
 * Number of consecutive full pages that may hand back the cursor we just
 * sent before pagination is aborted. Re-requesting the same cursor would
 * otherwise loop forever against a misbehaving RPC node.
 */
export const MAX_STALL_ITERATIONS = 3;

/**
 * Stable error codes surfaced by the event fetcher. Callers can branch on
 * `code` without parsing messages, and ops can alert on them.
 */
export type EventFetcherErrorCode =
  | "EVENT_FETCH_RETRIES_EXHAUSTED"
  | "EVENT_FETCH_NON_RETRYABLE"
  | "EVENT_FETCH_CURSOR_STALLED"
  | "EVENT_FETCH_INVALID_WINDOW";

/**
 * Fail-closed error thrown when a ledger window cannot be fetched in full.
 * We never return partial/empty results on failure so downstream settlement
 * cannot act on an incomplete view of chain state.
 */
export class EventFetcherError extends Error {
  readonly code: EventFetcherErrorCode;
  /** Whether re-running the same window later may succeed. */
  readonly retryable: boolean;
  readonly attempts: number;
  readonly startLedger: number;
  readonly cursor?: string;
  /** Correlation id shared by every page request for one window. */
  readonly requestId?: string;
  readonly cause?: unknown;

  constructor(
    code: EventFetcherErrorCode,
    message: string,
    details: {
      retryable: boolean;
      attempts: number;
      startLedger: number;
      cursor?: string;
      requestId?: string;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = "EventFetcherError";
    this.code = code;
    this.retryable = details.retryable;
    this.attempts = details.attempts;
    this.startLedger = details.startLedger;
    this.cursor = details.cursor;
    this.requestId = details.requestId;
    this.cause = details.cause;
  }
}

/**
 * Thrown when the RPC keeps returning the cursor that was just requested,
 * i.e. pagination is making no progress.
 */
export class CursorStallError extends EventFetcherError {
  constructor(
    cursor: string,
    iterations: number,
    details: { startLedger: number; requestId?: string }
  ) {
    super(
      "EVENT_FETCH_CURSOR_STALLED",
      `Event fetch cursor ${cursor} did not advance after ${iterations} pages`,
      { retryable: true, attempts: iterations, cursor, ...details }
    );
    this.name = "CursorStallError";
  }
}

/** Thrown at construction time when the fetcher config is unusable. */
export class EventFetcherConfigError extends Error {
  constructor(message: string) {
    super(`Invalid EventFetcher config: ${message}`);
    this.name = "EventFetcherConfigError";
  }
}

function validateConfig(config: Required<EventFetcherConfig>): void {
  const urls = Array.isArray(config.rpcUrl) ? config.rpcUrl : [config.rpcUrl];
  if (urls.length === 0 || urls.some((u) => typeof u !== "string" || !u)) {
    throw new EventFetcherConfigError("rpcUrl must be a non-empty URL");
  }
  if (typeof config.contractId !== "string" || !config.contractId) {
    throw new EventFetcherConfigError("contractId is required");
  }
  if (
    !Number.isInteger(config.pageLimit) ||
    config.pageLimit < 1 ||
    config.pageLimit > MAX_PAGE_LIMIT
  ) {
    throw new EventFetcherConfigError(
      `pageLimit must be an integer between 1 and ${MAX_PAGE_LIMIT}`
    );
  }
  if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0) {
    throw new EventFetcherConfigError(
      "maxRetries must be a non-negative integer"
    );
  }
  for (const key of ["retryDelayMs", "fetchTimeoutMs"] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 0) {
      throw new EventFetcherConfigError(`${key} must be a non-negative number`);
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
    } as Required<EventFetcherConfig>;
    validateConfig(this.config);
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
   *
   * The first page is requested by `startLedger`; every following page by
   * the cursor the RPC returned (the two are mutually exclusive in
   * `getEvents`). Pagination stops at the first short page or once a page
   * reaches past `endLedger`. Events are returned in RPC order, each at most
   * once, and only when their ledger lies inside the window.
   *
   * Fail-closed: if any page cannot be fetched after retries, or the cursor
   * stops advancing, throws an `EventFetcherError` instead of returning a
   * partial result.
   *
   * Applies an extended ingestion backoff when the RPC endpoint has been
   * consecutively unreachable (Issue #710).
   */
  async fetchByLedgerWindow(window: LedgerWindow): Promise<FetchEventsResult> {
    const { startLedger, endLedger } = window;
    const requestId = randomUUID();

    if (
      !Number.isInteger(startLedger) ||
      !Number.isInteger(endLedger) ||
      startLedger < 1 ||
      endLedger < startLedger
    ) {
      throw new EventFetcherError(
        "EVENT_FETCH_INVALID_WINDOW",
        `Invalid ledger window [${startLedger}, ${endLedger}]`,
        { retryable: false, attempts: 0, startLedger, requestId }
      );
    }

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

    const events: RawChainEvent[] = [];
    const seenIds = new Set<string>();
    let duplicates = 0;
    let pages = 0;
    let latestLedger = 0;
    let cursor: string | undefined;
    let stallIterations = 0;

    for (;;) {
      const page = await this.fetchPageWithRetry(
        startLedger,
        requestId,
        cursor
      );
      pages += 1;
      latestLedger = page.latestLedger;

      for (const raw of page.events) {
        if (raw.ledger < startLedger || raw.ledger > endLedger) continue;
        if (seenIds.has(raw.id)) {
          duplicates += 1;
          continue;
        }
        seenIds.add(raw.id);
        events.push(this.toRawEvent(raw));
      }

      const next = this.nextCursor(page, endLedger);
      if (next === undefined) break;

      if (next === cursor) {
        stallIterations += 1;
        this.telemetry.record("indexer.rpc.cursor_stalled", 1, {
          requestId,
          iterations: String(stallIterations),
        });
        if (stallIterations >= MAX_STALL_ITERATIONS) {
          throw new CursorStallError(next, stallIterations, {
            startLedger,
            requestId,
          });
        }
      } else {
        stallIterations = 0;
      }
      cursor = next;
    }

    if (duplicates > 0) {
      this.telemetry.record("indexer.events.duplicate_skipped", duplicates, {
        requestId,
      });
    }

    this.telemetry.record("indexer.events.fetched", events.length, {
      startLedger: String(startLedger),
      endLedger: String(endLedger),
      pages: String(pages),
      requestId,
    });

    return { events, latestLedger };
  }

  /**
   * Cursor for the next page, or undefined when the window is exhausted: a
   * short page means the RPC has nothing more to return, and a page whose
   * last event lies beyond `endLedger` has already covered the window.
   */
  private nextCursor(
    page: StellarRpc.Api.GetEventsResponse,
    endLedger: number
  ): string | undefined {
    const last = page.events[page.events.length - 1];
    if (!last || page.events.length < this.config.pageLimit) return undefined;
    if (last.ledger > endLedger) return undefined;
    // Prefer the response-level cursor; older RPC nodes only expose a
    // per-event paging token. Event ids are valid cursors as a last resort.
    return page.cursor || (last as any).pagingToken || last.id;
  }

  /**
   * Fetch a single page, retrying transient RPC failures with the shared
   * jittered-backoff policy in retry.ts (bounded by config.maxRetries).
   * Uses StellarTransport for multi-endpoint failover and circuit breaking.
   */
  private async fetchPageWithRetry(
    startLedger: number,
    requestId: string,
    cursor?: string
  ): Promise<StellarRpc.Api.GetEventsResponse> {
    const { maxRetries, retryDelayMs } = this.config;
    let attempts = 0;

    try {
      return await withRetry(
        async () => {
          attempts += 1;
          try {
            const response = await this.requestPage(startLedger, cursor);
            // Success — reset the consecutive disconnection counter
            this.consecutiveDisconnections = 0;
            this.telemetry.record(
              "indexer.rpc.page_fetched",
              response.events.length,
              { attempt: String(attempts), requestId }
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
        {
          maxRetries,
          retryDelayMs,
          onRetry: ({ attempt, classification, delayMs }) =>
            this.telemetry.record("indexer.rpc.retry", 1, {
              attempt: String(attempt),
              classification,
              delayMs: String(Math.round(delayMs)),
              requestId,
            }),
        }
      );
    } catch (err) {
      // withRetry wraps the final failure; classify on the underlying error.
      const cause =
        err instanceof RetryExhaustedError
          ? (err as { cause?: unknown }).cause
          : err;
      const retryable = isTransientError(cause);
      const code: EventFetcherErrorCode = retryable
        ? "EVENT_FETCH_RETRIES_EXHAUSTED"
        : "EVENT_FETCH_NON_RETRYABLE";

      this.telemetry.record("indexer.rpc.error", 1, {
        attempt: String(attempts),
        transient: String(retryable),
        code,
        requestId,
      });

      throw new EventFetcherError(
        code,
        retryable
          ? `Event fetch exhausted ${attempts} attempt(s) for ledger ${startLedger}: ${errorMessage(cause)}`
          : `Event fetch failed with non-retryable error for ledger ${startLedger}: ${errorMessage(cause)}`,
        { retryable, attempts, startLedger, cursor, requestId, cause }
      );
    }
  }

  /** Issue one `getEvents` call through the failover transport. */
  private async requestPage(
    startLedger: number,
    cursor?: string
  ): Promise<StellarRpc.Api.GetEventsResponse> {
    const { pageLimit, contractId, fetchTimeoutMs } = this.config;
    const filters = [{ contractIds: [contractId] }];
    // Soroban RPC rejects requests that carry both startLedger and cursor.
    const request: StellarRpc.Api.GetEventsRequest = cursor
      ? { filters, cursor, limit: pageLimit }
      : { filters, startLedger, limit: pageLimit };

    let rpcError: unknown;
    try {
      return await this.transport.execute(async (url: string) => {
        // Prefer an injected mock server (unit tests replace this.server
        // with a stub). In production, rebuild the RPC client whenever
        // transport fails over to a different endpoint URL.
        if (this.server instanceof StellarRpc.Server) {
          this.server = new StellarRpc.Server(url);
        }
        try {
          return await withTimeout(
            this.server.getEvents(request),
            fetchTimeoutMs
          );
        } catch (err) {
          rpcError = err;
          throw err;
        }
      }, "getEvents");
    } catch (err) {
      // Once every endpoint has failed, StellarTransport replaces the RPC
      // error with a generic one; keep the original so retry classification
      // still sees the network/HTTP failure.
      throw rpcError ?? err;
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

/**
 * Reject with a transient ETIMEDOUT error when `promise` has not settled
 * within `timeoutMs` (0 disables the timeout), so a stalled RPC endpoint
 * cannot block the ingestion loop indefinitely. The timer is always cleared
 * so a fast rejection cannot leave an unhandled timeout behind.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              Object.assign(
                new Error(
                  `EventFetcher: getEvents timed out after ${timeoutMs}ms`
                ),
                { code: "ETIMEDOUT" }
              )
            ),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
