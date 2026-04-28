/**
 * Shared typed config loader.
 *
 * Reads and validates environment variables once. All services should import
 * `loadConfig` (or the pre-built `config` singleton) from this module instead
 * of reading `process.env` directly.
 *
 * This module is side-effect free: nothing runs at import time.
 * Call `loadConfig()` explicitly (or use the exported `config` singleton).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireString(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requirePositiveInt(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `Environment variable ${name} must be a positive integer, got: ${JSON.stringify(raw)}`
    );
  }
  return value;
}

function requirePositiveNumber(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Environment variable ${name} must be a positive number, got: ${JSON.stringify(raw)}`
    );
  }
  return value;
}

function requireEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback?: T
): T {
  const raw = (process.env[name] ?? fallback) as T | undefined;
  if (raw === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  if (!allowed.includes(raw)) {
    throw new Error(
      `Environment variable ${name} must be one of ${allowed.join("|")}, got: ${JSON.stringify(raw)}`
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export interface AppConfig {
  server: {
    port: number;
    nodeEnv: "development" | "production" | "test";
  };
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  stellar: {
    network: string;
    horizonUrl: string;
  };
  oracle: {
    secretKey: string;
    challengeWindowSeconds: number;
  };
  rateLimit: {
    windowMs: number;
    max: number;
    heavyWindowMs: number;
    heavyMax: number;
    writeWindowMs: number;
    writeMax: number;
  };
  indexer: {
    ingestionIntervalMs: number;
    networkId: string;
    cursorKey: string;
    checkpointFlushEveryBatches: number;
    logLevel: "debug" | "info" | "warn" | "error";
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const NODE_ENVS = ["development", "production", "test"] as const;

/**
 * Parse and validate all environment variables.
 * Throws a descriptive error on the first missing or invalid value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Temporarily swap process.env so helpers pick up the provided env map.
  const original = process.env;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).env = env;

  try {
    return {
      server: {
        port: requirePositiveInt("PORT", 3000),
        nodeEnv: requireEnum("NODE_ENV", NODE_ENVS, "development"),
      },
      database: {
        url: requireString("DATABASE_URL"),
      },
      redis: {
        url: requireString("REDIS_URL", "redis://localhost:6379"),
      },
      stellar: {
        network: requireString("STELLAR_NETWORK", "testnet"),
        horizonUrl: requireString(
          "STELLAR_HORIZON_URL",
          "https://horizon-testnet.stellar.org"
        ),
      },
      oracle: {
        secretKey: requireString("ORACLE_SECRET_KEY", ""),
        challengeWindowSeconds: requirePositiveInt(
          "ORACLE_CHALLENGE_WINDOW_SECONDS",
          86400
        ),
      },
      rateLimit: {
        windowMs: requirePositiveNumber("RATE_LIMIT_WINDOW_MS", 60_000),
        max: requirePositiveInt("RATE_LIMIT_MAX", 100),
        heavyWindowMs: requirePositiveNumber(
          "RATE_LIMIT_HEAVY_WINDOW_MS",
          60_000
        ),
        heavyMax: requirePositiveInt("RATE_LIMIT_HEAVY_MAX", 20),
        writeWindowMs: requirePositiveNumber(
          "RATE_LIMIT_WRITE_WINDOW_MS",
          60_000
        ),
        writeMax: requirePositiveInt("RATE_LIMIT_WRITE_MAX", 10),
      },
      indexer: {
        ingestionIntervalMs: requirePositiveNumber(
          "INDEXER_INGESTION_INTERVAL_MS",
          5_000
        ),
        networkId: requireString("INDEXER_NETWORK_ID", "mainnet"),
        cursorKey: requireString("INDEXER_CURSOR_KEY", "ingestion"),
        checkpointFlushEveryBatches: requirePositiveInt(
          "INDEXER_CHECKPOINT_FLUSH_EVERY_BATCHES",
          10
        ),
        logLevel: requireEnum("INDEXER_LOG_LEVEL", LOG_LEVELS, "info"),
      },
    };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).env = original;
  }
}

/**
 * Pre-built singleton for services that don't need a custom env map.
 * Evaluated lazily on first access so tests can set env vars before import.
 */
let _config: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/** Reset the singleton (useful in tests). */
export function resetConfig(): void {
  _config = undefined;
}
