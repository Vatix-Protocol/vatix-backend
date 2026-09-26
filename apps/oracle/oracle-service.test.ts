/**
 * Unit tests for Oracle Service
 *
 * Covers primary resolution, fallback switching, metrics, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OracleService } from "./oracle-service.js";
import { PrimaryAdapter } from "./primary-adapter.js";
import { FallbackAdapter } from "./fallback-adapter.js";
import { oracleFailClosedTotal } from "../../src/services/metrics.js";
import {
  oracleDryRunEvaluationsTotal,
  oracleProviderAttemptsTotal,
} from "../../src/services/metrics.js";
import type { SubmissionQueue } from "./submission-queue.js";
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

  afterEach(() => {
    vi.unstubAllEnvs();
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
    it("fails closed in production without invoking an off-chain fallback", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const failingPrimary = createMockAdapter("primary", true);
      const service = new OracleService({
        primaryAdapter: failingPrimary,
        fallbackAdapter,
        enableFallback: true,
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

  describe("failover timeout policy", () => {
    it("should pass primary timeout to primary adapter", async () => {
      const primaryAdapter = createMockAdapter("primary", false);
      const spy = vi.spyOn(primaryAdapter, "resolve");

      const service = new OracleService({
        primaryAdapter,
        fallbackAdapter,
        enableFallback: true,
        primaryTimeoutMs: 25000,
      });

      await service.resolve({
        marketId: "market-001",
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutMs: 25000,
        })
      );
    });

    it("should pass fallback timeout to fallback adapter on failover", async () => {
      const failingPrimary = createMockAdapter("primary", true);
      const fallbackAdapter = createMockAdapter("fallback", false);
      const spy = vi.spyOn(fallbackAdapter, "resolve");

      const service = new OracleService({
        primaryAdapter: failingPrimary,
        fallbackAdapter,
        enableFallback: true,
        primaryTimeoutMs: 5000,
        fallbackTimeoutMs: 25000,
      });

      await service.resolve({
        marketId: "market-001",
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutMs: 25000,
        })
      );
    });

    it("should increment fail-closed metric when both adapters fail", async () => {
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
      ).rejects.toThrow();

      const metrics = service.getMetrics();
      expect(metrics.totalOutageCount).toBe(1);
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
      primaryAdapter.resolve = vi
        .fn()
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
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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

      await expect(
        service.resolve({
          marketId: "market-001",
          oracleAddress:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        })
      ).rejects.toThrow();

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
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(result.source).toBe("fallback");
      expect(primaryAdapter.resolve).toHaveBeenCalledTimes(3); // Initial + 2 retries
      expect(fallbackAdapter.resolve).toHaveBeenCalledTimes(1);
    });
  });

  describe("fail closed — total provider outage", () => {
    it("does not call enqueue callback when both primary and fallback fail", async () => {
      const failingPrimary = createMockAdapter("primary", true);
      const failingFallback = createMockAdapter("fallback", true);
      const enqueueCallback = vi.fn().mockResolvedValue(undefined);

      const service = new OracleService({
        primaryAdapter: failingPrimary,
        fallbackAdapter: failingFallback,
        enableFallback: true,
        enqueueCallback,
      });

      await expect(
        service.resolve({
          marketId: "market-001",
          oracleAddress:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        })
      ).rejects.toThrow("All providers failed");

      // Enqueue must never be called when all providers fail
      expect(enqueueCallback).not.toHaveBeenCalled();
    });

    it("increments totalOutageCount metric on total provider failure", async () => {
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
      ).rejects.toThrow();

      const metrics = service.getMetrics();
      expect(metrics.totalOutageCount).toBe(1);
      expect(metrics.primaryFailureCount).toBe(1);
      expect(metrics.fallbackFailureCount).toBe(1);
    });

    it("emits the vatix_oracle_fail_closed_total prometheus counter on total provider failure", async () => {
      const failingPrimary = createMockAdapter("primary", true);
      const failingFallback = createMockAdapter("fallback", true);

      const service = new OracleService({
        primaryAdapter: failingPrimary,
        fallbackAdapter: failingFallback,
        enableFallback: true,
      });

      const before = (await oracleFailClosedTotal.get()).values[0]?.value ?? 0;

      await expect(
        service.resolve({
          marketId: "market-001",
          oracleAddress:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        })
      ).rejects.toThrow();

      const after = (await oracleFailClosedTotal.get()).values[0]?.value ?? 0;
      expect(after).toBe(before + 1);
    });

    it("does not increment totalOutageCount when primary succeeds", async () => {
      const service = new OracleService({
        primaryAdapter,
        fallbackAdapter,
        enableFallback: true,
      });

      await service.resolve({
        marketId: "market-001",
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      const metrics = service.getMetrics();
      expect(metrics.totalOutageCount).toBe(0);
      expect(metrics.primarySuccessCount).toBe(1);
    });
  });

  describe("enqueue callback", () => {
    it("should invoke enqueue callback on successful resolution", async () => {
      const enqueueCallback = vi.fn().mockResolvedValue(undefined);

      const service = new OracleService({
        primaryAdapter,
        fallbackAdapter,
        enqueueCallback,
      });

      await service.resolve({
        marketId: "market-001",
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(enqueueCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.any(String),
          request: expect.objectContaining({
            marketId: "market-001",
          }),
          status: "pending",
        })
      );
    });

    it("should not break resolution if enqueue fails", async () => {
      const enqueueCallback = vi
        .fn()
        .mockRejectedValue(new Error("Queue error"));

      const service = new OracleService({
        primaryAdapter,
        fallbackAdapter,
        enqueueCallback,
      });

      const result = await service.resolve({
        marketId: "market-001",
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(result.source).toBe("primary");
      expect(enqueueCallback).toHaveBeenCalled();
    });

    it("should skip enqueue if not configured", async () => {
      const service = new OracleService({
        primaryAdapter,
        fallbackAdapter,
      });

      const result = await service.resolve({
        marketId: "market-001",
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(result.source).toBe("primary");
      // No error, enqueue was skipped gracefully
    });
  });

  describe("confidence gate (#991)", () => {
    function lowConfidenceAdapter(source: string): ProviderAdapter {
      return {
        getSource: () => source,
        healthCheck: vi.fn().mockResolvedValue(true),
        resolve: vi.fn().mockResolvedValue({
          outcome: true,
          confidence: 0.2,
          source,
          timestamp: new Date().toISOString(),
        } as ProviderResult),
      };
    }

    it("refuses to enqueue a low-confidence primary result", async () => {
      const enqueueCallback = vi.fn().mockResolvedValue(undefined);
      const service = new OracleService({
        primaryAdapter: lowConfidenceAdapter("primary"),
        fallbackAdapter,
        enqueueCallback,
        minConfidenceThreshold: 0.75,
      });

      await expect(
        service.resolve({
          marketId: "market-low-confidence",
          oracleAddress:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        })
      ).rejects.toThrow(/confidence/i);

      expect(enqueueCallback).not.toHaveBeenCalled();
    });

    it("increments oracleFailClosedTotal when refusing a low-confidence result", async () => {
      const before = (await oracleFailClosedTotal.get()).values.reduce(
        (sum, v) => sum + v.value,
        0
      );

      const service = new OracleService({
        primaryAdapter: lowConfidenceAdapter("primary"),
        fallbackAdapter,
        minConfidenceThreshold: 0.75,
      });

      await expect(
        service.resolve({
          marketId: "market-low-confidence-2",
          oracleAddress:
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        })
      ).rejects.toThrow();

      const after = (await oracleFailClosedTotal.get()).values.reduce(
        (sum, v) => sum + v.value,
        0
      );
      expect(after).toBeGreaterThan(before);
    });

    it("enqueues when confidence meets the threshold", async () => {
      const enqueueCallback = vi.fn().mockResolvedValue(undefined);
      const service = new OracleService({
        primaryAdapter,
        fallbackAdapter,
        enqueueCallback,
        minConfidenceThreshold: 0.5,
      });

      const result = await service.resolve({
        marketId: "market-ok-confidence",
        oracleAddress:
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      expect(enqueueCallback).toHaveBeenCalled();
    });
  });
});

/**
 * Prometheus counters are process-global, so assertions read the series for an
 * exact label set (absent series count as 0) rather than assuming a value.
 */
async function counterValue(
  counter: {
    get: () => Promise<{
      values: { labels: Record<string, string | number>; value: number }[];
    }>;
  },
  labels: Record<string, string>
): Promise<number> {
  const { values } = await counter.get();
  return values
    .filter((series) =>
      Object.entries(labels).every(
        ([key, val]) => String(series.labels[key]) === val
      )
    )
    .reduce((sum, series) => sum + series.value, 0);
}

const METRICS_REQUEST: ResolutionRequest = {
  marketId: "market-metrics-001",
  oracleAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

describe("per-provider failover metrics (#1147)", () => {
  it("records a primary success", async () => {
    const before = await counterValue(oracleProviderAttemptsTotal, {
      provider: "primary",
      outcome: "success",
    });

    const service = new OracleService({
      primaryAdapter: createMockAdapter("primary", false),
      fallbackAdapter: createMockAdapter("fallback", false),
      enableFallback: true,
    });
    await service.resolve(METRICS_REQUEST);

    expect(
      await counterValue(oracleProviderAttemptsTotal, {
        provider: "primary",
        outcome: "success",
      })
    ).toBe(before + 1);
  });

  it("records the primary failure and the fallback success when failover kicks in", async () => {
    const primaryFailureBefore = await counterValue(
      oracleProviderAttemptsTotal,
      { provider: "primary", outcome: "failure" }
    );
    const fallbackSuccessBefore = await counterValue(
      oracleProviderAttemptsTotal,
      { provider: "fallback", outcome: "success" }
    );

    const service = new OracleService({
      primaryAdapter: createMockAdapter("primary", true),
      fallbackAdapter: createMockAdapter("fallback", false),
      enableFallback: true,
    });
    const result = await service.resolve(METRICS_REQUEST);

    expect(result.source).toBe("fallback");
    expect(
      await counterValue(oracleProviderAttemptsTotal, {
        provider: "primary",
        outcome: "failure",
      })
    ).toBe(primaryFailureBefore + 1);
    expect(
      await counterValue(oracleProviderAttemptsTotal, {
        provider: "fallback",
        outcome: "success",
      })
    ).toBe(fallbackSuccessBefore + 1);
  });

  it("records the fallback failure on a total provider outage", async () => {
    const before = await counterValue(oracleProviderAttemptsTotal, {
      provider: "fallback",
      outcome: "failure",
    });

    const service = new OracleService({
      primaryAdapter: createMockAdapter("primary", true),
      fallbackAdapter: createMockAdapter("fallback", true),
      enableFallback: true,
    });
    await expect(service.resolve(METRICS_REQUEST)).rejects.toThrow();

    expect(
      await counterValue(oracleProviderAttemptsTotal, {
        provider: "fallback",
        outcome: "failure",
      })
    ).toBe(before + 1);
  });
});

/**
 * A provider that always returns a confidence below the gate.
 */
function lowConfidenceAdapter(source: string): ProviderAdapter {
  return {
    getSource: () => source,
    healthCheck: vi.fn().mockResolvedValue(true),
    resolve: vi.fn().mockResolvedValue({
      outcome: true,
      confidence: 0.2,
      source,
      timestamp: new Date().toISOString(),
    } as ProviderResult),
  };
}

describe("dry-run mode (#1146)", () => {
  it("defaults to off so an unconfigured deployment keeps the real path", () => {
    const service = new OracleService({
      primaryAdapter: createMockAdapter("primary", false),
      fallbackAdapter: createMockAdapter("fallback", false),
      enableFallback: true,
    });

    expect(service.isDryRun()).toBe(false);
  });

  it("resolves and scores the market but never invokes the enqueue callback", async () => {
    const enqueueCallback = vi.fn().mockResolvedValue(undefined);
    const before = await counterValue(oracleDryRunEvaluationsTotal, {
      would: "submit",
    });

    const service = new OracleService({
      primaryAdapter: createMockAdapter("primary", false),
      fallbackAdapter: createMockAdapter("fallback", false),
      enableFallback: true,
      enqueueCallback,
      dryRun: true,
    });

    expect(service.isDryRun()).toBe(true);

    const result = await service.resolve(METRICS_REQUEST);

    expect(result.source).toBe("primary");
    expect(enqueueCallback).not.toHaveBeenCalled();
    expect(
      await counterValue(oracleDryRunEvaluationsTotal, { would: "submit" })
    ).toBe(before + 1);
  });

  it("never writes to a submission queue in dry-run", async () => {
    const submissionQueue = {
      enqueue: vi.fn(),
    } as unknown as SubmissionQueue;

    const service = new OracleService({
      primaryAdapter: createMockAdapter("primary", false),
      fallbackAdapter: createMockAdapter("fallback", false),
      enableFallback: true,
      submissionQueue,
      dryRun: true,
    });

    await service.resolve(METRICS_REQUEST);

    expect(submissionQueue.enqueue).not.toHaveBeenCalled();
  });

  it("still fails closed on a low-confidence result and reports it as would-refuse", async () => {
    const enqueueCallback = vi.fn().mockResolvedValue(undefined);
    const before = await counterValue(oracleDryRunEvaluationsTotal, {
      would: "fail_closed",
    });

    const service = new OracleService({
      primaryAdapter: lowConfidenceAdapter("primary"),
      fallbackAdapter: createMockAdapter("fallback", false),
      enqueueCallback,
      minConfidenceThreshold: 0.75,
      // Fallback off: the confidence refusal must propagate rather than being
      // masked by a healthy fallback provider.
      enableFallback: false,
      dryRun: true,
    });

    await expect(service.resolve(METRICS_REQUEST)).rejects.toThrow(
      /confidence/i
    );

    expect(enqueueCallback).not.toHaveBeenCalled();
    expect(
      await counterValue(oracleDryRunEvaluationsTotal, { would: "fail_closed" })
    ).toBe(before + 1);
  });
});
