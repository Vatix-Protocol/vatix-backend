/**
 * Unit tests for Oracle Service
 *
 * Covers primary resolution, fallback switching, metrics, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OracleService } from "./oracle-service.js";
import { PrimaryAdapter } from "./primary-adapter.js";
import { FallbackAdapter } from "./fallback-adapter.js";
import type {
  ProviderAdapter,
  ProviderResult,
  ResolutionRequest,
} from "./provider-adapter.js";

/**
 * Create a mock adapter for testing.
 */
function createMockAdapter(
  source: string,
  shouldFail: boolean = false
): ProviderAdapter {
  return {
    getSource: () => source,
    healthCheck: vi.fn().mockResolvedValue(!shouldFail),
    resolve: vi.fn().mockImplementation(async (_request: ResolutionRequest) => {
      if (shouldFail) {
        throw new Error(`${source} provider failed`);
      }
      return {
        outcome: true,
        confidence: 0.95,
        source,
        timestamp: new Date().toISOString(),
      } as ProviderResult;
    }),
  };
}

describe("OracleService", () => {
  let primaryAdapter: ProviderAdapter;
  let fallbackAdapter: ProviderAdapter;
  let oracleService: OracleService;

  beforeEach(() => {
    primaryAdapter = createMockAdapter("primary", false);
    fallbackAdapter = createMockAdapter("fallback", false);
    oracleService = new OracleService({
      primaryAdapter,
      fallbackAdapter,
      enableFallback: true,
    });
  });

  describe("primary resolution", () => {
    it("should resolve using primary adapter when it succeeds", async () => {
      const result = await oracleService.resolve({
        marketId: "market-001",
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(result.source).toBe("primary");
      expect(result.outcome).toBe(true);
      expect(primaryAdapter.resolve).toHaveBeenCalledTimes(1);
      expect(fallbackAdapter.resolve).not.toHaveBeenCalled();
    });

    it("should return result with source attribution", async () => {
      const result = await oracleService.resolve({
        marketId: "market-001",
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(result.source).toBe("primary");
      expect(result.timestamp).toBeDefined();
    });
  });

  describe("fallback switching", () => {
    it("should switch to fallback when primary fails", async () => {
      const failingPrimary = createMockAdapter("primary", true);
      const service = new OracleService({
        primaryAdapter: failingPrimary,
        fallbackAdapter,
        enableFallback: true,
      });

      const result = await service.resolve({
        marketId: "market-001",
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(result.source).toBe("fallback");
      expect(failingPrimary.resolve).toHaveBeenCalledTimes(1);
      expect(fallbackAdapter.resolve).toHaveBeenCalledTimes(1);
    });

    it("should throw when both primary and fallback fail", async () => {
      const failingPrimary = createMockAdapter("primary", true);
      const failingFallback = createMockAdapter("fallback", true);
      const service = new OracleService({
        primaryAdapter: failingPrimary,
        fallbackAdapter: failingFallback,
        enableFallback: true,
      });

      await expect(
        service.resolve({
          marketId: "market-001",
          oracleAddress:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        })
      ).rejects.toThrow("All providers failed");
    });

    it("should not use fallback when disabled", async () => {
      const failingPrimary = createMockAdapter("primary", true);
      const service = new OracleService({
        primaryAdapter: failingPrimary,
        fallbackAdapter,
        enableFallback: false,
      });

      await expect(
        service.resolve({
          marketId: "market-001",
          oracleAddress:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        })
      ).rejects.toThrow("primary provider failed");

      expect(fallbackAdapter.resolve).not.toHaveBeenCalled();
    });
  });

  describe("metrics", () => {
    it("should track primary success count", async () => {
      await oracleService.resolve({
        marketId: "market-001",
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      const metrics = oracleService.getMetrics();
      expect(metrics.primarySuccessCount).toBe(1);
      expect(metrics.primaryFailureCount).toBe(0);
      expect(metrics.fallbackUsageCount).toBe(0);
      expect(metrics.totalAttempts).toBe(1);
    });

    it("should track fallback usage count", async () => {
      const failingPrimary = createMockAdapter("primary", true);
      const service = new OracleService({
        primaryAdapter: failingPrimary,
        fallbackAdapter,
        enableFallback: true,
      });

      await service.resolve({
        marketId: "market-001",
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      const metrics = service.getMetrics();
      expect(metrics.primaryFailureCount).toBe(1);
      expect(metrics.fallbackUsageCount).toBe(1);
      expect(metrics.totalAttempts).toBe(1);
    });

    it("should reset metrics", async () => {
      await oracleService.resolve({
        marketId: "market-001",
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      oracleService.resetMetrics();
      const metrics = oracleService.getMetrics();
      expect(metrics.primarySuccessCount).toBe(0);
      expect(metrics.totalAttempts).toBe(0);
    });
  });

  describe("health check", () => {
    it("should return true when primary is healthy", async () => {
      const healthy = await oracleService.healthCheck();
      expect(healthy).toBe(true);
    });

    it("should return false when primary is unhealthy", async () => {
      const unhealthyPrimary = createMockAdapter("primary", true);
      const service = new OracleService({
        primaryAdapter: unhealthyPrimary,
        fallbackAdapter,
        enableFallback: true,
      });

      const healthy = await service.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  describe("adapter access", () => {
    it("should return primary adapter", () => {
      expect(oracleService.getPrimaryAdapter()).toBe(primaryAdapter);
    });

    it("should return fallback adapter", () => {
      expect(oracleService.getFallbackAdapter()).toBe(fallbackAdapter);
    });
  });

  describe("retries", () => {
    it("should retry on transient failures", async () => {
      const transientError = new Error("Network timeout");
      const primaryAdapter = createMockAdapter("primary", false);
      primaryAdapter.resolve = vi.fn()
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValue({
          outcome: true,
          confidence: 0.95,
          source: "primary",
          timestamp: new Date().toISOString(),
        } as ProviderResult);

      const service = new OracleService({
        primaryAdapter,
        fallbackAdapter,
        retryConfig: { maxRetries: 3, initialDelayMs: 1, useJitter: false },
      });

      const result = await service.resolve({
        marketId: "market-001",
        oracleAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(result.source).toBe("primary");
      expect(primaryAdapter.resolve).toHaveBeenCalledTimes(3);
      expect(service.getMetrics().retryCount).toBe(2);
    });

    it("should not retry on non-transient failures", async () => {
      const nonTransientError = new Error("HTTP 400 Bad Request");
      const primaryAdapter = createMockAdapter("primary", false);
      primaryAdapter.resolve = vi.fn().mockRejectedValue(nonTransientError);

      const service = new OracleService({
        primaryAdapter,
        fallbackAdapter,
        retryConfig: { maxRetries: 3, initialDelayMs: 1, useJitter: false },
      });

      await expect(service.resolve({
        marketId: "market-001",
        oracleAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      })).rejects.toThrow();

      expect(primaryAdapter.resolve).toHaveBeenCalledTimes(1);
      expect(service.getMetrics().retryCount).toBe(0);
    });

    it("should switch to fallback after all retries fail", async () => {
      const transientError = new Error("Network timeout");
      const primaryAdapter = createMockAdapter("primary", false);
      primaryAdapter.resolve = vi.fn().mockRejectedValue(transientError);

      const service = new OracleService({
        primaryAdapter,
        fallbackAdapter,
        retryConfig: { maxRetries: 2, initialDelayMs: 1, useJitter: false },
      });

      const result = await service.resolve({
        marketId: "market-001",
        oracleAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(result.source).toBe("fallback");
      expect(primaryAdapter.resolve).toHaveBeenCalledTimes(3); // Initial + 2 retries
      expect(fallbackAdapter.resolve).toHaveBeenCalledTimes(1);
    });
  });
});
