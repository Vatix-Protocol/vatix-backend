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

const ACCEPTED_NODE_ENVS: NodeEnv[] = ["development", "test", "production"];
const ACCEPTED_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

/** Env map accepted by all loaders — compatible with process.env and plain objects in tests. */
export type Env = Record<string, string | undefined>;

/** Safe accessor for process.env that works without requiring @types/node in the shared package. */
const processEnv: Env =
  (
    (globalThis as Record<string, unknown>)["process"] as
      | { env: Env }
      | undefined
  )?.env ?? {};

// ---------------------------------------------------------------------------
// Validation helpers (pure functions — no side effects)
// ---------------------------------------------------------------------------

function requireString(name: string, env: Env): string {
  const raw = env[name];
  if (!raw || raw.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
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
    throw new Error(`Missing required environment variable: ${name}`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be a positive integer, got: ${JSON.stringify(raw)}`
    );
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(
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
    throw new Error(
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
    throw new Error(
      `${name} must be a number >= ${min}, got: ${JSON.stringify(raw)}`
    );
  }
  return value;
}

function loadNodeEnv(env: Env): NodeEnv {
  const raw = env["NODE_ENV"] ?? "development";
  if (!ACCEPTED_NODE_ENVS.includes(raw as NodeEnv)) {
    throw new Error(
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
    throw new Error(
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
    | (new (input: string) => { protocol: string; hostname: string })
    | undefined;
  if (!URLCtor) {
    throw new Error("URL constructor is not available in this environment");
  }
  let parsed: { protocol: string; hostname: string };
  try {
    parsed = new URLCtor(raw);
  } catch {
    throw new Error(
      `${name} is not a valid URL (expected format: ${allowedProtocols[0]}//host/path)`
    );
  }
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error(
      `${name} must use one of [${allowedProtocols.join(", ")}], got: ${JSON.stringify(parsed.protocol)}`
    );
  }
  if (!parsed.hostname) {
    throw new Error(`${name} must include a hostname`);
  }
  return raw;
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
}

/**
 * Loads and validates the base config shared by all services.
 *
 * @param env - Defaults to process.env. Pass a custom object in tests.
 */
export function loadBaseConfig(env: Env = processEnv): BaseConfig {
  const nodeEnv = loadNodeEnv(env);

  // CORS: parse comma-separated list or fall back to per-environment defaults
  const rawCors = env.CORS_ALLOWED_ORIGINS;
  let corsAllowedOrigins: string[];
  if (rawCors && rawCors.trim() !== "") {
    corsAllowedOrigins = rawCors
      .split(",")
      .map((o) => o.trim())
      .filter((o): o is string => o.length > 0);
  } else if (nodeEnv === "production") {
    corsAllowedOrigins = [];
  } else {
    corsAllowedOrigins = ["http://localhost:3000", "http://localhost:5173"];
  }

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
    stellarHorizonUrl: optionalString(
      "STELLAR_HORIZON_URL",
      "https://horizon-testnet.stellar.org",
      env
    ),
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
  };
}

// ---------------------------------------------------------------------------
// Indexer config
// ---------------------------------------------------------------------------

export interface IndexerConfig {
  nodeEnv: NodeEnv;
  stellarRpcUrl: string;
  ingestionIntervalMs: number;
  networkId: string;
  cursorKey: string;
  checkpointFlushEveryBatches: number;
  logLevel: LogLevel;
}

/**
 * Loads and validates indexer-specific config.
 *
 * @param env - Defaults to process.env. Pass a custom object in tests.
 */
export function loadIndexerConfig(env: Env = processEnv): IndexerConfig {
  return {
    nodeEnv: loadNodeEnv(env),
    stellarRpcUrl: loadUrl("STELLAR_RPC_URL", env, ["https:", "http:"]),
    ingestionIntervalMs: requireMinNumber(
      "INDEXER_INGESTION_INTERVAL_MS",
      env,
      100,
      5_000
    ),
    networkId: optionalString("INDEXER_NETWORK_ID", "mainnet", env),
    cursorKey: optionalString("INDEXER_CURSOR_KEY", "ingestion", env),
    checkpointFlushEveryBatches: requirePositiveInt(
      "INDEXER_CHECKPOINT_FLUSH_EVERY_BATCHES",
      env,
      { fallback: 10 }
    ),
    logLevel: loadLogLevel("INDEXER_LOG_LEVEL", env, "info"),
  };
}

// ---------------------------------------------------------------------------
// Finalization worker config
// ---------------------------------------------------------------------------

export interface FinalizationConfig {
  intervalMs: number;
  challengeWindowSeconds: number;
  logLevel: LogLevel;
}

/**
 * Loads and validates finalization worker config.
 *
 * @param env - Defaults to process.env. Pass a custom object in tests.
 */
export function loadFinalizationConfig(
  env: Env = processEnv
): FinalizationConfig {
  return {
    intervalMs: requireMinNumber("FINALIZATION_INTERVAL_MS", env, 1000, 60_000),
    challengeWindowSeconds: requireNonNegativeNumber(
      "FINALIZATION_CHALLENGE_WINDOW_SECONDS",
      env,
      3600
    ),
    logLevel: loadLogLevel("FINALIZATION_LOG_LEVEL", env, "info"),
  };
}
