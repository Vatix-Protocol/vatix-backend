/**
 * Unified typed config loader for all Vatix services.
 *
 * This module is side-effect free — it exports loader functions and types only.
 * Each service calls the relevant loader at startup and passes the result around
 * rather than importing process.env directly.
 *
 * Sections:
 *   - Shared primitives (NodeEnv, LogLevel, helpers)
 *   - loadBaseConfig()   — server, database, redis, stellar, security, cors, rate-limiting
 *   - loadIndexerConfig() — indexer-specific fields
 *   - loadFinalizationConfig() — finalization worker fields
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type NodeEnv = "development" | "test" | "production";
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Stable, machine-readable config error codes. Shared by every service's
 * fail-closed boot gate (see docs/env-validation.md) so operators and tests
 * can match on the code instead of parsing free-form message text.
 */
export const CONFIG_ERROR_CODES = {
  /** A required variable is absent or empty. */
  ENV_MISSING: "ENV_MISSING",
  /** A variable is present but malformed. */
  ENV_INVALID: "ENV_INVALID",
} as const;

export type ConfigErrorCode =
  (typeof CONFIG_ERROR_CODES)[keyof typeof CONFIG_ERROR_CODES];

/**
 * Thrown when an environment variable fails validation.
 * statusCode 400 signals that the caller supplied an invalid value.
 */
export class ConfigValidationError extends Error {
  readonly statusCode = 400;
  /**
   * Stable error code (see {@link CONFIG_ERROR_CODES}) when the throwing
   * call site supplies one; undefined for legacy throws that predate codes.
   */
  readonly code?: ConfigErrorCode;
  /**
   * Name of the offending environment variable — never its value — for
   * safe logging and log-based alerting.
   */
  readonly variable?: string;

  constructor(
    message: string,
    options: { code?: ConfigErrorCode; variable?: string } = {}
  ) {
    super(message);
    this.name = "ConfigValidationError";
    this.code = options.code;
    this.variable = options.variable;
  }
}

import { resolveCorsAllowedOrigins } from "./cors.js";
import type { NodeEnv as CorsNodeEnv } from "./cors.js";

const ACCEPTED_NODE_ENVS: NodeEnv[] = ["development", "test", "production"];
const ACCEPTED_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

/** Env map accepted by all loaders — compatible with process.env and plain objects in tests. */
export type Env = Record<string, string | undefined>;

/** Safe accessor for process.env that works without requiring @types/node in the shared package. */
const processEnv: Env =
  (
    (globalThis as Record<string, unknown>)["process"] as
      { env: Env } | undefined
  )?.env ?? {};

// ---------------------------------------------------------------------------
// Validation helpers (pure functions — no side effects)
// ---------------------------------------------------------------------------

function requireString(name: string, env: Env): string {
  const raw = env[name];
  if (!raw || raw.trim() === "") {
    throw new ConfigValidationError(
      `Missing required environment variable: ${name}`
    );
  }
  return raw.trim();
}

function optionalString(name: string, fallback: string, env: Env): string {
  const raw = env[name];
  return raw && raw.trim() !== "" ? raw.trim() : fallback;
}

function requirePositiveInt(
  name: string,
  env: Env,
  options: { fallback?: number; max?: number } = {}
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (options.fallback !== undefined) return options.fallback;
    throw new ConfigValidationError(
      `Missing required environment variable: ${name}`
    );
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigValidationError(
      `${name} must be a positive integer, got: ${JSON.stringify(raw)}`
    );
  }
  if (options.max !== undefined && value > options.max) {
    throw new ConfigValidationError(
      `${name} must be <= ${options.max}, got: ${JSON.stringify(raw)}`
    );
  }
  return value;
}

function requireNonNegativeNumber(
  name: string,
  env: Env,
  fallback: number
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigValidationError(
      `${name} must be a non-negative number, got: ${JSON.stringify(raw)}`
    );
  }
  return value;
}

function requireMinNumber(
  name: string,
  env: Env,
  min: number,
  fallback: number
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new ConfigValidationError(
      `${name} must be a number >= ${min}, got: ${JSON.stringify(raw)}`
    );
  }
  return value;
}

function loadNodeEnv(env: Env): NodeEnv {
  const raw = env["NODE_ENV"] ?? "development";
  if (!ACCEPTED_NODE_ENVS.includes(raw as NodeEnv)) {
    throw new ConfigValidationError(
      `NODE_ENV must be one of ${ACCEPTED_NODE_ENVS.join(" | ")}, got: ${JSON.stringify(raw)}`
    );
  }
  return raw as NodeEnv;
}

function loadLogLevel(
  name: string,
  env: Env,
  fallback: LogLevel = "info"
): LogLevel {
  const raw = (env[name] ?? fallback) as LogLevel;
  if (!ACCEPTED_LOG_LEVELS.includes(raw)) {
    throw new ConfigValidationError(
      `${name} must be one of ${ACCEPTED_LOG_LEVELS.join("|")}, got: ${JSON.stringify(raw)}`
    );
  }
  return raw;
}

/**
 * Validates a URL env var. Protocol must be one of the allowed schemes.
 * Never logs the full value to avoid leaking credentials.
 */
function loadUrl(name: string, env: Env, allowedProtocols: string[]): string {
  const raw = requireString(name, env);
  // URL is available in Node.js >= 10 globally; no DOM lib needed at runtime.
  // We cast through unknown to satisfy strict TS without requiring lib: ["DOM"].
  const URLCtor = (globalThis as Record<string, unknown>)["URL"] as
    (new (input: string) => { protocol: string; hostname: string }) | undefined;
  if (!URLCtor) {
    throw new ConfigValidationError(
      "URL constructor is not available in this environment"
    );
  }
  let parsed: { protocol: string; hostname: string };
  try {
    parsed = new URLCtor(raw);
  } catch {
    throw new ConfigValidationError(
      `${name} is not a valid URL (expected format: ${allowedProtocols[0]}//host/path)`
    );
  }
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new ConfigValidationError(
      `${name} must use one of [${allowedProtocols.join(", ")}], got: ${JSON.stringify(parsed.protocol)}`
    );
  }
  if (!parsed.hostname) {
    throw new ConfigValidationError(`${name} must include a hostname`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Horizon URL ↔ network consistency (#1134)
// ---------------------------------------------------------------------------

/**
 * Known public Horizon hosts and the network each one serves, keyed by the
 * identifier accepted in `STELLAR_NETWORK`. Hosts are public infrastructure —
 * safe to echo in boot-time error messages.
 */
export const KNOWN_HORIZON_NETWORK_HOSTS = {
  testnet: ["horizon-testnet.stellar.org"],
  mainnet: ["horizon.stellar.org"],
} as const;

/** Network-appropriate default Horizon URL when STELLAR_HORIZON_URL is unset. */
export function defaultHorizonUrlForNetwork(network: string): string {
  return network.trim().toLowerCase() === "mainnet"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
}

/**
 * Best-effort network affinity of a Horizon hostname: exact matches against
 * {@link KNOWN_HORIZON_NETWORK_HOSTS}, then a `testnet`/`mainnet` token in a
 * self-hosted hostname (e.g. `horizon.testnet.internal.example.com`).
 * Returns undefined when the host gives no signal — self-hosted Horizon
 * instances cannot be verified from the URL alone and are allowed.
 */
function horizonHostNetwork(hostname: string): string | undefined {
  for (const [network, hosts] of Object.entries(KNOWN_HORIZON_NETWORK_HOSTS)) {
    if ((hosts as readonly string[]).includes(hostname)) return network;
  }
  const tokens = hostname.split(/[^a-z0-9]+/);
  if (tokens.includes("testnet")) return "testnet";
  if (tokens.includes("mainnet")) return "mainnet";
  return undefined;
}

/**
 * Asserts that the configured Horizon URL belongs to the network declared by
 * `STELLAR_NETWORK` (issue #1134). Fail-closed: a Horizon endpoint on the
 * wrong network would submit account/ledger reads against the wrong chain
 * while the deployment believes it is on another one.
 *
 * Skip semantics: unknown/custom `STELLAR_NETWORK` values are skipped (no
 * known-good host set), and self-hosted hosts without a `testnet`/`mainnet`
 * token are allowed because they cannot be verified from the URL alone.
 *
 * @param horizonUrl - Resolved STELLAR_HORIZON_URL (after defaulting)
 * @param network - Declared deployment network (STELLAR_NETWORK)
 * @throws {ConfigValidationError} when the URL is malformed or network-mismatched
 */
export function assertHorizonUrlMatchesNetwork(
  horizonUrl: string,
  network: string
): void {
  const normalized = network.trim().toLowerCase();
  if (!(normalized in KNOWN_HORIZON_NETWORK_HOSTS)) return;

  let hostname: string;
  try {
    hostname = new URL(horizonUrl).hostname.toLowerCase();
  } catch {
    throw new ConfigValidationError(
      `STELLAR_HORIZON_URL is not a valid URL (expected format: https://host), got: ${JSON.stringify(horizonUrl)}`
    );
  }

  if (!hostname) {
    throw new ConfigValidationError(
      "STELLAR_HORIZON_URL must include a hostname"
    );
  }

  const hostNetwork = horizonHostNetwork(hostname);
  if (hostNetwork !== undefined && hostNetwork !== normalized) {
    throw new ConfigValidationError(
      `STELLAR_HORIZON_URL host "${hostname}" belongs to Stellar ${hostNetwork}, which does not match STELLAR_NETWORK="${normalized}": ` +
        `expected a ${normalized} Horizon endpoint (e.g. ${defaultHorizonUrlForNetwork(normalized)})`
    );
  }
}

// ---------------------------------------------------------------------------
// Base config — consumed by API server, and optionally by other services
// ---------------------------------------------------------------------------

export interface RateLimitTier {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitConfig {
  global: RateLimitTier;
  heavy: RateLimitTier;
  write: RateLimitTier;
}

export interface BaseConfig {
  /** Runtime environment. */
  nodeEnv: NodeEnv;
  /** TCP port the API server binds to. */
  port: number;
  /** Max request body size in bytes. */
  bodyLimitBytes: number;
  /** PostgreSQL connection string. Never logged in full. */
  databaseUrl: string;
  /** Redis connection URL. */
  redisUrl: string;
  /** Stellar Soroban RPC endpoint. */
  stellarRpcUrl: string;
  /** Stellar network identifier (e.g. "testnet" | "mainnet"). */
  stellarNetwork: string;
  /** Stellar Horizon REST API URL. */
  stellarHorizonUrl: string;
  /** Oracle resolution challenge window in seconds. */
  oracleChallengeWindowSeconds: number;
  /** Ed25519 secret key for oracle signing. Never logged. */
  oracleSecretKey: string;
  /** API key for protected endpoints. Never logged. */
  apiKey: string;
  /** Admin bearer token. Never logged. */
  adminToken: string;
  /** Allowed CORS origins. */
  corsAllowedOrigins: string[];
  /** Rate limiting tiers. */
  rateLimiting: RateLimitConfig;
  /**
   * Maximum entries retained per per-market audit stream (approximate trim).
   * The global stream retains 10× this value.
   * Configurable via AUDIT_STREAM_MAXLEN. Default: 100 000.
   */
  auditStreamMaxlen: number;
}

/**
 * Loads and validates the base config shared by all services.
 *
 * @param env - Defaults to process.env. Pass a custom object in tests.
 */
export function loadBaseConfig(env: Env = processEnv): BaseConfig {
  const nodeEnv = loadNodeEnv(env);

  const corsAllowedOrigins = resolveCorsAllowedOrigins(
    nodeEnv as CorsNodeEnv,
    env.CORS_ALLOWED_ORIGINS
  );

  return {
    nodeEnv,
    port: requirePositiveInt("PORT", env, { fallback: 3000, max: 65535 }),
    bodyLimitBytes: requirePositiveInt("BODY_LIMIT_BYTES", env, {
      fallback: 65536,
    }),
    databaseUrl: loadUrl("DATABASE_URL", env, ["postgresql:", "postgres:"]),
    redisUrl: loadUrl("REDIS_URL", env, ["redis:", "rediss:"]),
    stellarRpcUrl: loadUrl("STELLAR_RPC_URL", env, ["https:", "http:"]),
    stellarNetwork: optionalString("STELLAR_NETWORK", "testnet", env),
    stellarHorizonUrl: (() => {
      // Network-matched default and validation (#1134): a mainnet deployment
      // must not silently fall back to — or be configured with — the testnet
      // Horizon host. Fail closed on mismatch before anything boots.
      const network = optionalString("STELLAR_NETWORK", "testnet", env);
      const horizonUrl = optionalString(
        "STELLAR_HORIZON_URL",
        defaultHorizonUrlForNetwork(network),
        env
      );
      assertHorizonUrlMatchesNetwork(horizonUrl, network);
      return horizonUrl;
    })(),
    oracleChallengeWindowSeconds: requirePositiveInt(
      "ORACLE_CHALLENGE_WINDOW_SECONDS",
      env,
      { fallback: 86400 }
    ),
    oracleSecretKey: requireString("ORACLE_SECRET_KEY", env),
    apiKey: requireString("API_KEY", env),
    adminToken: requireString("ADMIN_TOKEN", env),
    corsAllowedOrigins,
    rateLimiting: {
      global: {
        windowMs: requireMinNumber("RATE_LIMIT_WINDOW_MS", env, 1, 60_000),
        maxRequests: requirePositiveInt("RATE_LIMIT_MAX", env, {
          fallback: 100,
        }),
      },
      heavy: {
        windowMs: requireMinNumber(
          "RATE_LIMIT_HEAVY_WINDOW_MS",
          env,
          1,
          60_000
        ),
        maxRequests: requirePositiveInt("RATE_LIMIT_HEAVY_MAX", env, {
          fallback: 20,
        }),
      },
      write: {
        windowMs: requireMinNumber(
          "RATE_LIMIT_WRITE_WINDOW_MS",
          env,
          1,
          60_000
        ),
        maxRequests: requirePositiveInt("RATE_LIMIT_WRITE_MAX", env, {
          fallback: 10,
        }),
      },
    },
    auditStreamMaxlen: requirePositiveInt("AUDIT_STREAM_MAXLEN", env, {
      fallback: 100_000,
    }),
  };
}

// ---------------------------------------------------------------------------
// Indexer config
// ---------------------------------------------------------------------------

export interface IndexerConfig {
  nodeEnv: NodeEnv;
  stellarRpcUrl: string;
  /** Soroban contract ID whose events the indexer ingests. */
  contractId: string;
  ingestionIntervalMs: number;
  /** Max ledgers to scan per ingestion tick. */
  ledgerWindowSize: number;
  /** Max events to fetch per RPC page. */
  batchSize: number;
  networkId: string;
  cursorKey: string;
  checkpointFlushEveryBatches: number;
  logLevel: LogLevel;
  /**
   * Number of ledgers gap that triggers a fail-closed pause of the ingestion
   * loop. When the detected gap size (network tip minus last indexed ledger
   * across a non-contiguous sequence) meets or exceeds this threshold, the
   * loop emits a critical log and halts until an operator intervenes.
   * Set to 0 to disable the fail-closed behaviour (gaps are back-filled without
   * pausing regardless of size).
   * Configurable via INDEXER_GAP_PAUSE_THRESHOLD. Default: 1000.
   */
  gapPauseThreshold: number;
  /**
   * Maximum number of ledgers that the gap backfill is allowed to re-fetch in
   * a single catch-up run. Prevents unbounded back-filling when a very wide
   * gap is detected. Any gap larger than this is clamped and a warning is
   * emitted so the operator can widen the limit or investigate.
   * Configurable via INDEXER_BACKFILL_MAX_LEDGERS. Default: 500.
   */
  backfillMaxLedgers: number;
}

/**
 * A Stellar contract ID strkey: the literal `C` followed by 55 base32
 * characters (`A`–`Z`, `2`–`7`). Anything else cannot be a deployed Soroban
 * contract address.
 */
const CONTRACT_ID_STRKEY_PATTERN = /^C[A-Z2-7]{55}$/;

/**
 * Resolves the Soroban contract ID the indexer should ingest.
 * `INDEXER_CONTRACT_ID` takes precedence over the legacy `MARKET_CONTRACT_ID`
 * alias. Exported so other services (e.g. the oracle worker) resolve the
 * contract ID the same way instead of re-implementing this precedence.
 *
 * Fail-closed rules:
 *   - Missing/blank in every environment → `ENV_MISSING` (the indexer cannot
 *     ingest anything without a target contract, so booting would silently
 *     produce an empty index).
 *   - Both aliases set to *different* values → warning, because a half-rotated
 *     deployment is address drift waiting to happen. Precedence is preserved
 *     and the resolved value is still the non-deprecated one.
 *   - `NODE_ENV=production` and a malformed strkey → `ENV_INVALID`. A truncated
 *     or chain-mismatched ID silently ingests the wrong contract (or none) on
 *     the money path, so production refuses to boot rather than run blind.
 *
 * @param env - Defaults to process.env. Pass a custom object in tests.
 * @throws ConfigValidationError always carrying a stable `code` and `variable`.
 */
export function loadIndexerContractId(env: Env): string {
  const primary = env["INDEXER_CONTRACT_ID"]?.trim() ?? "";
  const legacyAlias = env["MARKET_CONTRACT_ID"]?.trim() ?? "";

  if (primary !== "" && legacyAlias !== "" && primary !== legacyAlias) {
    // Never log the values themselves is not required here (contract IDs are
    // public addresses), but keeping the message value-free keeps log
    // aggregation and alert rules stable.
    console.warn(
      "[env] WARNING: INDEXER_CONTRACT_ID and MARKET_CONTRACT_ID are both set " +
        "and disagree; using INDEXER_CONTRACT_ID. A disagreement usually means " +
        "a half-rotated deployment — verify the target contract before ingesting."
    );
  }

  const contractId = primary || legacyAlias;
  if (contractId === "") {
    throw new ConfigValidationError(
      "Missing required environment variable: INDEXER_CONTRACT_ID (or MARKET_CONTRACT_ID)",
      {
        code: CONFIG_ERROR_CODES.ENV_MISSING,
        variable: "INDEXER_CONTRACT_ID",
      }
    );
  }

  if (
    env["NODE_ENV"] === "production" &&
    !CONTRACT_ID_STRKEY_PATTERN.test(contractId)
  ) {
    throw new ConfigValidationError(
      "INDEXER_CONTRACT_ID must be a Stellar contract strkey (C + 55 base32 chars), got: invalid value",
      {
        code: CONFIG_ERROR_CODES.ENV_INVALID,
        variable: "INDEXER_CONTRACT_ID",
      }
    );
  }

  return contractId;
}

export function loadIndexerConfig(env: Env = processEnv): IndexerConfig {
  return {
    nodeEnv: loadNodeEnv(env),
    stellarRpcUrl: loadUrl("STELLAR_RPC_URL", env, ["https:", "http:"]),
    contractId: loadIndexerContractId(env),
    ingestionIntervalMs: requireMinNumber(
      "INDEXER_INGESTION_INTERVAL_MS",
      env,
      100,
      5_000
    ),
    ledgerWindowSize: requirePositiveInt("INDEXER_LEDGER_WINDOW_SIZE", env, {
      fallback: 100,
      max: 1000,
    }),
    batchSize: requirePositiveInt("INDEXER_BATCH_SIZE", env, {
      fallback: 100,
      max: 500,
    }),
    networkId: optionalString("INDEXER_NETWORK_ID", "mainnet", env),
    cursorKey: optionalString("INDEXER_CURSOR_KEY", "ingestion", env),
    checkpointFlushEveryBatches: requirePositiveInt(
      "INDEXER_CHECKPOINT_FLUSH_EVERY_BATCHES",
      env,
      { fallback: 10 }
    ),
    logLevel: loadLogLevel("INDEXER_LOG_LEVEL", env, "info"),
    gapPauseThreshold: requireNonNegativeNumber(
      "INDEXER_GAP_PAUSE_THRESHOLD",
      env,
      1000
    ),
    backfillMaxLedgers: requirePositiveInt(
      "INDEXER_BACKFILL_MAX_LEDGERS",
      env,
      {
        fallback: 500,
      }
    ),
  };
}

// ---------------------------------------------------------------------------
// Finalization worker config
// ---------------------------------------------------------------------------

export interface FinalizationConfig {
  intervalMs: number;
  /**
   * Challenge window (seconds) the finalization worker enforces before a
   * PROPOSED candidate becomes eligible for on-chain finalization. This MUST
   * equal {@link FinalizationConfig.onChainChallengeWindowSeconds} — a drift
   * lets the worker finalize markets earlier or later than the resolution
   * contract allows. In production the loader fails fast if they disagree.
   */
  challengeWindowSeconds: number;
  /**
   * Canonical challenge window enforced by the on-chain resolution contract,
   * sourced from ORACLE_CHALLENGE_WINDOW_SECONDS (the single value shared with
   * the API and oracle scheduler). Used to detect backend/chain drift.
   */
  onChainChallengeWindowSeconds: number;
  /**
   * True when FINALIZATION_CHALLENGE_WINDOW_SECONDS is set to a value that
   * differs from the on-chain window. Only reachable outside production
   * (production rejects the drift in the loader); the worker logs a warning
   * on startup so the local stub is never silent.
   */
  challengeWindowOverridden: boolean;
  logLevel: LogLevel;
}

/**
 * Loads and validates finalization worker config.
 *
 * The challenge window defaults to ORACLE_CHALLENGE_WINDOW_SECONDS — the same
 * value the API and oracle scheduler use and the one that must match the
 * on-chain resolution contract. FINALIZATION_CHALLENGE_WINDOW_SECONDS remains
 * as a dev/test-only override; in NODE_ENV=production a value that drifts from
 * the on-chain window is a fatal ConfigValidationError (issue #950).
 *
 * @param env - Defaults to process.env. Pass a custom object in tests.
 */
export function loadFinalizationConfig(
  env: Env = processEnv
): FinalizationConfig {
  const nodeEnv = loadNodeEnv(env);
  const onChainChallengeWindowSeconds = requirePositiveInt(
    "ORACLE_CHALLENGE_WINDOW_SECONDS",
    env,
    { fallback: 86_400 }
  );

  const rawOverride = env["FINALIZATION_CHALLENGE_WINDOW_SECONDS"];
  const hasOverride = rawOverride !== undefined && rawOverride !== "";
  let challengeWindowSeconds = onChainChallengeWindowSeconds;

  if (hasOverride) {
    challengeWindowSeconds = requireNonNegativeNumber(
      "FINALIZATION_CHALLENGE_WINDOW_SECONDS",
      env,
      onChainChallengeWindowSeconds
    );
    if (
      nodeEnv === "production" &&
      challengeWindowSeconds !== onChainChallengeWindowSeconds
    ) {
      throw new ConfigValidationError(
        `FINALIZATION_CHALLENGE_WINDOW_SECONDS (${challengeWindowSeconds}) must ` +
          `match the on-chain resolution contract window ` +
          `ORACLE_CHALLENGE_WINDOW_SECONDS (${onChainChallengeWindowSeconds}) in ` +
          `production. A drift lets the finalization worker finalize markets ` +
          `too early or too late relative to the chain. Remove the override or ` +
          `align the two values.`
      );
    }
  }

  return {
    intervalMs: requireMinNumber("FINALIZATION_INTERVAL_MS", env, 1000, 60_000),
    challengeWindowSeconds,
    onChainChallengeWindowSeconds,
    challengeWindowOverridden:
      hasOverride && challengeWindowSeconds !== onChainChallengeWindowSeconds,
    logLevel: loadLogLevel("FINALIZATION_LOG_LEVEL", env, "info"),
  };
}

// ---------------------------------------------------------------------------
// Oracle worker config
// ---------------------------------------------------------------------------

export interface OracleWorkerConfig {
  submissionPollIntervalMs: number;
  submissionMaxRetries: number;
  submissionVisibilityTimeoutMs: number;
  logLevel: LogLevel;
  redisUrl: string;
  databaseUrl: string;
}

/**
 * Loads and validates oracle worker config.
 *
 * @param env - Defaults to process.env. Pass a custom object in tests.
 */
export function loadOracleWorkerConfig(
  env: Env = processEnv
): OracleWorkerConfig {
  return {
    submissionPollIntervalMs: requireMinNumber(
      "ORACLE_SUBMISSION_POLL_INTERVAL_MS",
      env,
      1000,
      5_000
    ),
    submissionMaxRetries: requirePositiveInt(
      "ORACLE_SUBMISSION_MAX_RETRIES",
      env,
      { fallback: 3 }
    ),
    submissionVisibilityTimeoutMs: requirePositiveInt(
      "ORACLE_SUBMISSION_VISIBILITY_TIMEOUT_MS",
      env,
      { fallback: 300_000 }
    ),
    logLevel: loadLogLevel("ORACLE_SUBMISSION_LOG_LEVEL", env, "info"),
    redisUrl: loadUrl("REDIS_URL", env, ["redis:", "rediss:"]),
    databaseUrl: loadUrl("DATABASE_URL", env, ["postgresql:", "postgres:"]),
  };
}
