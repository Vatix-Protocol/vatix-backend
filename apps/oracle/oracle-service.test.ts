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
});
