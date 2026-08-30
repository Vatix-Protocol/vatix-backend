import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  StellarTransport,
  parseEndpointUrls,
  loadStellarEndpoints,
} from "./stellarTransport.js";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("StellarTransport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should initialize with single endpoint", () => {
    const transport = new StellarTransport(
      ["https://horizon.stellar.org"],
      mockLogger as any
    );

    expect(transport.getActiveEndpoint()).toBe("https://horizon.stellar.org");
    expect(transport.getCircuitState()).toBe("closed");
  });

  it("should initialize with multiple endpoints", () => {
    const urls = [
      "https://horizon.stellar.org",
      "https://backup1.stellar.org",
      "https://backup2.stellar.org",
    ];
    const transport = new StellarTransport(urls, mockLogger as any);

    expect(transport.getEndpoints()).toHaveLength(3);
    expect(transport.getActiveEndpoint()).toBe(urls[0]);
  });

  it("should throw on empty endpoint list", () => {
    expect(() => {
      new StellarTransport([], mockLogger as any);
    }).toThrow("At least one Stellar endpoint URL is required");
  });

  it("should execute successfully on first endpoint", async () => {
    const transport = new StellarTransport(
      ["https://primary.org", "https://secondary.org"],
      mockLogger as any
    );

    const result = await transport.execute(async (url) => {
      return `success from ${url}`;
    });

    expect(result).toBe("success from https://primary.org");
    expect(transport.getCircuitState()).toBe("closed");
  });

  it("should failover on error", async () => {
    let callCount = 0;
    const transport = new StellarTransport(
      ["https://primary.org", "https://secondary.org"],
      mockLogger as any
    );

    const result = await transport.execute(async (url) => {
      callCount++;
      if (url === "https://primary.org") {
        throw new Error("Connection refused");
      }
      return `success from ${url}`;
    });

    expect(result).toBe("success from https://secondary.org");
    expect(callCount).toBe(2);
  });

  it("should open circuit after threshold failures", async () => {
    const transport = new StellarTransport(
      ["https://primary.org", "https://secondary.org"],
      mockLogger as any,
      { failureThreshold: 2, windowMs: 60000 }
    );

    // First failure
    try {
      await transport.execute(async (url) => {
        if (url === "https://primary.org") {
          throw new Error("Connection refused");
        }
        return "success";
      });
    } catch {
      // Expected to succeed on secondary
    }

    // Second failure (at primary)
    try {
      await transport.execute(async (url) => {
        if (url === "https://primary.org") {
          throw new Error("Connection refused");
        }
        return "success";
      });
    } catch {
      // Expected to succeed on secondary
    }

    // Third attempt should open circuit at primary
    try {
      await transport.execute(async (url) => {
        throw new Error("All endpoints failed");
      });
    } catch {
      // Expected to fail
    }

    expect(mockLogger.error).toHaveBeenCalledWith(
      "Circuit breaker opened",
      expect.any(Object)
    );
  });

  it("should transition to half-open after cooldown", async () => {
    vi.useFakeTimers();

    const transport = new StellarTransport(
      ["https://primary.org"],
      mockLogger as any,
      { failureThreshold: 1, cooldownMs: 1000 }
    );

    // Trigger failure to open circuit
    try {
      await transport.execute(async () => {
        throw new Error("Connection failed");
      });
    } catch {
      // Expected
    }

    expect(transport.getCircuitState()).toBe("open");

    // Advance time past cooldown
    vi.advanceTimersByTime(1100);

    // Next attempt should transition to half-open
    try {
      await transport.execute(async () => {
        throw new Error("Still failing");
      });
    } catch {
      // Expected
    }

    expect(mockLogger.info).toHaveBeenCalledWith(
      "Circuit breaker entering half-open state",
      expect.any(Object)
    );

    vi.useRealTimers();
  });

  it("should track endpoint metrics", async () => {
    const transport = new StellarTransport(
      ["https://primary.org", "https://secondary.org"],
      mockLogger as any
    );

    await transport.execute(async (url) => {
      if (url === "https://primary.org") {
        throw new Error("Failed");
      }
      return "success";
    });

    const endpoints = transport.getEndpoints();
    const primary = endpoints.find((e) => e.url === "https://primary.org");
    const secondary = endpoints.find((e) => e.url === "https://secondary.org");

    expect(primary?.failureCount).toBe(1);
    expect(secondary?.successCount).toBe(1);
  });
});

describe("parseEndpointUrls", () => {
  it("should parse comma-separated URLs", () => {
    const urls = parseEndpointUrls(
      "https://one.org, https://two.org, https://three.org"
    );
    expect(urls).toEqual([
      "https://one.org",
      "https://two.org",
      "https://three.org",
    ]);
  });

  it("should handle whitespace", () => {
    const urls = parseEndpointUrls("  https://one.org  ,  https://two.org  ");
    expect(urls).toEqual(["https://one.org", "https://two.org"]);
  });

  it("should return empty array for undefined", () => {
    expect(parseEndpointUrls(undefined)).toEqual([]);
  });

  it("should return empty array for empty string", () => {
    expect(parseEndpointUrls("")).toEqual([]);
  });
});

describe("loadStellarEndpoints", () => {
  it("should load from STELLAR_HORIZON_URLS", () => {
    const config = loadStellarEndpoints({
      STELLAR_HORIZON_URLS: "https://one.org, https://two.org",
    });
    expect(config.horizonUrls).toEqual(["https://one.org", "https://two.org"]);
  });

  it("should fallback to STELLAR_HORIZON_URL", () => {
    const config = loadStellarEndpoints({
      STELLAR_HORIZON_URL: "https://single.org",
    });
    expect(config.horizonUrls).toEqual(["https://single.org"]);
  });

  it("should use default for mainnet", () => {
    const config = loadStellarEndpoints(
      {},
      "Public Global Stellar Network ; September 2015"
    );
    expect(config.horizonUrls).toContain("https://horizon.stellar.org");
    expect(config.rpcUrls).toContain("https://soroban-mainnet.stellar.org:443");
  });

  it("should use default for testnet", () => {
    const config = loadStellarEndpoints(
      {},
      "Test SDF Network ; September 2015"
    );
    expect(config.horizonUrls).toContain("https://horizon-testnet.stellar.org");
    expect(config.rpcUrls).toContain("https://soroban-testnet.stellar.org:443");
  });

  it("should prioritize STELLAR_HORIZON_URLS over STELLAR_HORIZON_URL", () => {
    const config = loadStellarEndpoints({
      STELLAR_HORIZON_URLS: "https://urls.org",
      STELLAR_HORIZON_URL: "https://url.org",
    });
    expect(config.horizonUrls).toEqual(["https://urls.org"]);
  });
});
