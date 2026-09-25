export { EventFetcher } from "./eventFetcher.js";
export { parseTradeEvent, parseTradeEvents } from "./tradeParser.js";
export {
  parseResolutionEvent,
  parseResolutionEvents,
} from "./resolutionParser.js";
export {
  parseEventId,
  generateIdempotencyKey,
  withIdempotencyKey,
  insertIfNew,
} from "./idempotency.js";
export { consoleTelemetry } from "./telemetry.js";
export type { Telemetry } from "./telemetry.js";
export type {
  EventFetcherConfig,
  FetchEventsResult,
  LedgerWindow,
  NormalizedTrade,
  NormalizedResolution,
  NormalizedCollateralDeposit,
  NormalizedMarketCreated,
  MarketStatus,
  RawChainEvent,
  ResolutionOutcome,
  TradeDirection,
  TradeErrorCode,
  TradeOutcome,
} from "./types.js";
export type {
  IdempotencyComponents,
  IdempotencyKey,
  InsertResult,
  PersistedTrade,
  PersistedResolution,
} from "./idempotency.js";
export {
  TradeParseError,
  ResolutionParseError,
  CollateralDepositedParseError,
  MarketCreatedParseError,
} from "./types.js";
export type {
  BatchRecord,
  BatchWriteError,
  BatchWriteResult,
  BatchWriter,
} from "./batchWriter.js";
export { PrismaBatchWriter } from "./batchWriter.js";
export { PrismaCursorStorageClient } from "./storage.js";
export type { CursorStorageClient, CursorTransactionClient } from "./storage.js";
export { CursorConflictError, CursorStorageConfigError } from "./storage.js";
export {
  CollateralDepositedErrorCode,
  type CollateralDepositedErrorCode as CollateralDepositedErrorCodeType,
} from "./collateralDepositedParser.js";
export {
  ResolutionErrorCode,
  type ResolutionErrorCode as ResolutionErrorCodeType,
} from "./resolutionParser.js";
