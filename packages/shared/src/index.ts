export {
  REDACTED,
  REDACTION_TRUNCATED,
  MAX_REDACTION_DEPTH,
  SENSITIVE_KEYS,
  isSensitiveKey,
  redactObject,
  redactMeta,
} from "./logRedactor.js";

export { Logger, LoggerValidationError, LOG_LEVELS } from "./logger.js";
export type { LogLevel, ILogger } from "./logger.js";

export type {
  Env,
  NodeEnv,
  BaseConfig,
  IndexerConfig,
  FinalizationConfig,
  RateLimitConfig,
  RateLimitTier,
} from "./config.js";

export {
  ConfigValidationError,
  loadBaseConfig,
  loadIndexerConfig,
  loadFinalizationConfig,
} from "./config.js";

export { resolveCorsAllowedOrigins } from "./cors.js";

export type { ErrorEnvelope, CreateErrorEnvelopeInput } from "./errors.js";
export { createErrorEnvelope } from "./errors.js";

export type { SigningDomain } from "./signingDomain.js";
export {
  SIGNING_DOMAINS,
  STUB_NETWORK_PASSPHRASE,
  SigningDomainConfigError,
  resolveSigningNetworkPassphrase,
  buildDomainSeparatedMessage,
} from "./signingDomain.js";

// Market lifecycle: the single source of truth for status transitions and
// tradability. Re-exported here (in addition to the `./marketLifecycle`
// subpath) so every caller — routes, oracle, indexer, finalization worker —
// can reach `isTradable`/`canTransition` from the main package barrel
// instead of growing a second, driftable copy of the status matrix.
export type { MarketLifecycleState } from "./marketLifecycle.js";
export {
  MARKET_STATUSES,
  // Alias kept for callers that import the lifecycle enum by this name.
  MARKET_STATUSES as MARKET_LIFECYCLE_STATES,
  MARKET_QUESTION_MAX_LENGTH,
  MARKET_TRANSITIONS,
  INITIAL_MARKET_STATUSES,
  TRADABLE_MARKET_STATUSES,
  RESOLVABLE_MARKET_STATUSES,
  DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
  CLOCK_SKEW_TOLERANCE_ENV,
  MARKET_INVALID_TRANSITION_CODE,
  MARKET_NOT_TRADABLE_CODE,
  MarketTransitionError,
  resolveClockSkewToleranceMs,
  isPastEndTime,
  isMarketStatus,
  canTransition,
  assertTransition,
  isTerminal,
  isTradable,
  isResolvable,
  isInitialStatus,
} from "./marketLifecycle.js";
