import type { ILogger } from "./logger.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface EndpointMetrics {
  url: string;
  successCount: number;
  failureCount: number;
  lastError?: Error;
  lastAttemptAt?: Date;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  timeoutMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  windowMs: 60_000,
  cooldownMs: 30_000,
  timeoutMs: 15_000,
};

interface Endpoint {
  url: string;
  consecutiveFailures: number;
  lastFailureAt?: Date;
  state: CircuitState;
}

/**
 * Multi-endpoint failover with circuit breaker for Stellar RPC/Horizon.
 * Manages a list of endpoints, tracks failures, and automatically fails over
 * to healthy endpoints. Circuit breaker prevents hammering downed endpoints.
 */
export class StellarTransport {
  private endpoints: Endpoint[];
  private currentIndex: number = 0;
  private readonly config: CircuitBreakerConfig;
  private readonly logger: ILogger;
  private metrics: Map<string, EndpointMetrics> = new Map();

  constructor(
    urls: string[],
    logger: ILogger,
    config?: Partial<CircuitBreakerConfig>
  ) {
    if (!urls || urls.length === 0) {
      throw new Error("At least one Stellar endpoint URL is required");
    }

    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
    this.endpoints = urls.map((url) => ({
      url,
      consecutiveFailures: 0,
      state: "closed",
    }));

    // Initialize metrics
    for (const url of urls) {
      this.metrics.set(url, {
        url,
        successCount: 0,
        failureCount: 0,
      });
    }

    this.logger.info("StellarTransport initialized", {
      endpoints: urls.length,
      failureThreshold: this.config.failureThreshold,
      windowMs: this.config.windowMs,
      cooldownMs: this.config.cooldownMs,
    });
  }

  /**
   * Get the currently active endpoint URL.
   */
  getActiveEndpoint(): string {
    return this.endpoints[this.currentIndex].url;
  }

  /**
   * Get all endpoints with their current state and metrics.
   */
  getEndpoints(): EndpointMetrics[] {
    return this.endpoints.map((ep) => {
      const metrics = this.metrics.get(ep.url);
      return metrics || { url: ep.url, successCount: 0, failureCount: 0 };
    });
  }

  /**
   * Get circuit state for the currently active endpoint.
   */
  getCircuitState(): CircuitState {
    return this.endpoints[this.currentIndex].state;
  }

  /**
   * Execute a function against the active endpoint. On failure, attempt failover
   * to the next healthy endpoint.
   */
  async execute<T>(
    fn: (url: string) => Promise<T>,
    operationName: string = "operation"
  ): Promise<T> {
    const maxAttempts = this.endpoints.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const endpoint = this.endpoints[this.currentIndex];
      const metrics = this.metrics.get(endpoint.url)!;

      // Check circuit state
      if (endpoint.state === "open") {
        const timeSinceLastFailure = endpoint.lastFailureAt
          ? Date.now() - endpoint.lastFailureAt.getTime()
          : 0;

        if (timeSinceLastFailure >= this.config.cooldownMs) {
          endpoint.state = "half-open";
          this.logger.info("Circuit breaker entering half-open state", {
            endpoint: endpoint.url,
            operationName,
          });
        } else {
          this.failover();
          continue;
        }
      }

      try {
        const startTime = Date.now();
        const result = await Promise.race([
          fn(endpoint.url),
          this.createTimeout(),
        ]);
        const latency = Date.now() - startTime;

        // Success: reset failure counter and close circuit
        endpoint.consecutiveFailures = 0;
        if (endpoint.state === "half-open") {
          endpoint.state = "closed";
          this.logger.info("Circuit breaker closed", {
            endpoint: endpoint.url,
          });
        }

        metrics.successCount++;
        metrics.lastAttemptAt = new Date();

        this.logger.debug(`${operationName} succeeded`, {
          endpoint: endpoint.url,
          latencyMs: latency,
        });

        return result;
      } catch (error) {
        const latency = metrics.lastAttemptAt
          ? Date.now() - metrics.lastAttemptAt.getTime()
          : 0;
        metrics.failureCount++;
        metrics.lastError = error as Error;
        metrics.lastAttemptAt = new Date();

        endpoint.consecutiveFailures++;
        endpoint.lastFailureAt = new Date();

        const isTransient = this.isTransientError(error);

        this.logger.warn(`${operationName} failed`, {
          endpoint: endpoint.url,
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
          isTransient,
        });

        // Open circuit if threshold exceeded
        if (
          endpoint.state === "half-open" ||
          (endpoint.state === "closed" &&
            endpoint.consecutiveFailures >= this.config.failureThreshold)
        ) {
          endpoint.state = "open";
          this.logger.error("Circuit breaker opened", {
            endpoint: endpoint.url,
            consecutiveFailures: endpoint.consecutiveFailures,
          });
        }

        // Don't failover if no more endpoints or if permanent error
        if (attempt < maxAttempts - 1) {
          this.failover();
        } else if (!isTransient) {
          throw error;
        }
      }
    }

    throw new Error(
      `All ${maxAttempts} Stellar endpoints exhausted for ${operationName}`
    );
  }

  /**
   * Move to the next endpoint in the rotation.
   */
  private failover(): void {
    const previousIndex = this.currentIndex;
    this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;

    this.logger.info("Failover triggered", {
      from: this.endpoints[previousIndex].url,
      to: this.endpoints[this.currentIndex].url,
    });
  }

  /**
   * Classify error as transient (retriable) or permanent.
   */
  private isTransientError(error: unknown): boolean {
    if (!(error instanceof Error)) return true;

    const transientCodes = new Set([
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "socket hang up",
    ]);

    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (transientCodes.has(code) || transientCodes.has(error.message)) {
      return true;
    }

    // HTTP 5xx errors are transient
    if (error.message.includes("5")) {
      return true;
    }

    return false;
  }

  /**
   * Create a promise that rejects after the configured timeout.
   */
  private createTimeout(): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(`Operation timeout after ${this.config.timeoutMs}ms`)
          ),
        this.config.timeoutMs
      );
    });
  }
}

/**
 * Parse comma-separated endpoint URLs from a string.
 * Returns an empty array if the string is empty or only whitespace.
 */
export function parseEndpointUrls(input: string | undefined): string[] {
  if (!input || !input.trim()) {
    return [];
  }
  return input
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * Load multiple endpoints from env vars with fallback to single-URL legacy vars.
 * Precedence:
 * 1. STELLAR_HORIZON_URLS / STELLAR_RPC_URLS (comma-separated)
 * 2. STELLAR_HORIZON_URL / STELLAR_RPC_URL (single, legacy)
 * 3. Defaults (public Stellar endpoints)
 */
export interface EndpointConfig {
  horizonUrls: string[];
  rpcUrls: string[];
}

export function loadStellarEndpoints(
  env: NodeJS.ProcessEnv,
  defaultPassphrase?: string
): EndpointConfig {
  const horizonFromList = parseEndpointUrls(env.STELLAR_HORIZON_URLS);
  const horizonUrls =
    horizonFromList.length > 0
      ? horizonFromList
      : env.STELLAR_HORIZON_URL
        ? [env.STELLAR_HORIZON_URL]
        : [];

  const rpcFromList = parseEndpointUrls(env.STELLAR_RPC_URLS);
  const rpcUrls =
    rpcFromList.length > 0
      ? rpcFromList
      : env.STELLAR_RPC_URL
        ? [env.STELLAR_RPC_URL]
        : [];

  // Apply defaults if neither env var is set
  const passphrase = env.SOROBAN_NETWORK_PASSPHRASE || defaultPassphrase;
  if (horizonUrls.length === 0) {
    if (passphrase === "Public Global Stellar Network ; September 2015") {
      horizonUrls.push("https://horizon.stellar.org");
    } else {
      horizonUrls.push("https://horizon-testnet.stellar.org");
    }
  }

  if (rpcUrls.length === 0) {
    if (passphrase === "Public Global Stellar Network ; September 2015") {
      rpcUrls.push("https://soroban-mainnet.stellar.org:443");
    } else {
      rpcUrls.push("https://soroban-testnet.stellar.org:443");
    }
  }

  return { horizonUrls, rpcUrls };
}
