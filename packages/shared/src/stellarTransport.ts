import type { ILogger } from "./logger.js";
import {
  KNOWN_NETWORK_PASSPHRASES,
  isKnownStellarNetwork,
  normalizeStellarNetwork,
  type KnownStellarNetwork,
  type StellarEndpointKind,
} from "./networkConsistency.js";

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
    // Remember the last underlying failure. When every endpoint is exhausted
    // we must surface *that* error rather than a generic aggregate string:
    // callers classify the error to decide whether a retry can help, and an
    // opaque "all endpoints exhausted" Error looks permanent even when the
    // real cause was a transient socket reset.
    let lastError: unknown = null;

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
        lastError = error;
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

    if (lastError !== null) {
      throw lastError;
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
 * 3. Defaults (public Stellar endpoints for the declared network)
 *
 * #1133/#1134/#1135 — the defaults are derived from `STELLAR_NETWORK`, the
 * single source of truth for the target chain, and not from the passphrase.
 * The previous implementation inferred the network by string-comparing the
 * passphrase to the mainnet one, so a deployment that declared
 * `STELLAR_NETWORK=mainnet` but had no `SOROBAN_NETWORK_PASSPHRASE` set
 * silently resolved the **testnet** Horizon and RPC hosts. Every other boot
 * gate already treats `STELLAR_NETWORK` as authoritative, so deriving the
 * defaults from anything else contradicted the documented behaviour in
 * docs/env-validation.md ("the default is chosen from STELLAR_NETWORK").
 *
 * Resolution order for the declared network:
 *   1. `STELLAR_NETWORK` when it names a known network.
 *   2. the `defaultPassphrase` argument, for callers that resolve the network
 *      from a passphrase instead (custom/standalone networks).
 *   3. `testnet`, the documented default — never mainnet by omission.
 */
export interface EndpointConfig {
  horizonUrls: string[];
  rpcUrls: string[];
}

/** Public default endpoint per known network, used when no URL is configured. */
const DEFAULT_PUBLIC_ENDPOINTS = {
  testnet: {
    horizon: "https://horizon-testnet.stellar.org",
    rpc: "https://soroban-testnet.stellar.org:443",
  },
  mainnet: {
    horizon: "https://horizon.stellar.org",
    rpc: "https://soroban-mainnet.stellar.org:443",
  },
} as const satisfies Record<string, Record<StellarEndpointKind, string>>;

/** The mainnet passphrase, used only to infer a network from a passphrase. */
const MAINNET_PASSPHRASE = KNOWN_NETWORK_PASSPHRASES.mainnet;

/**
 * Resolves which known network the public defaults should be taken from.
 *
 * `STELLAR_NETWORK` wins whenever it is actually set — that is the whole point
 * of the #1133/#1134/#1135 change. Only when it is unset/absent does the
 * passphrase argument get a say, which keeps callers that resolve their network
 * from a passphrase (custom/standalone chains) working as before.
 *
 * Note the distinction between "unset" and "explicitly testnet": the gate
 * elsewhere defaults `STELLAR_NETWORK` to `testnet`, but here an absent value
 * must fall through to the passphrase rather than pinning testnet.
 *
 * Returns the known network to take public defaults from, defaulting to
 * testnet when nothing identifies the chain.
 */
function resolveDefaultNetwork(
  env: NodeJS.ProcessEnv,
  defaultPassphrase?: string
): KnownStellarNetwork {
  const rawNetwork = env.STELLAR_NETWORK?.trim();
  if (rawNetwork) {
    const declared = normalizeStellarNetwork(rawNetwork);
    if (isKnownStellarNetwork(declared)) return declared;
    // An explicitly declared custom network has no published endpoints; fall
    // through so a known passphrase can still identify the real chain.
  }

  const passphrase = env.SOROBAN_NETWORK_PASSPHRASE || defaultPassphrase;
  if (passphrase === MAINNET_PASSPHRASE) return "mainnet";
  if (passphrase === KNOWN_NETWORK_PASSPHRASES.testnet) return "testnet";

  // Nothing identifies the chain. The documented default is testnet, and
  // testnet is the safe direction to guess in: a custom/standalone deployment
  // must point at an endpoint explicitly, and one that does not is caught by
  // the caller's own required-variable check, not silently served mainnet.
  return "testnet";
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
  const network = resolveDefaultNetwork(env, defaultPassphrase);
  if (horizonUrls.length === 0) {
    horizonUrls.push(DEFAULT_PUBLIC_ENDPOINTS[network].horizon);
  }
  if (rpcUrls.length === 0) {
    rpcUrls.push(DEFAULT_PUBLIC_ENDPOINTS[network].rpc);
  }

  return { horizonUrls, rpcUrls };
}
