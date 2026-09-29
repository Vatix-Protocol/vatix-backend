/**
 * Oracle Boot Flow Tests
 *
 * Covers apps/oracle/main.ts's poll() — the per-cycle
 * fetch-markets -> resolve -> sign -> persist -> enqueue pipeline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockPrisma = vi.hoisted(() => ({
  market: { findMany: vi.fn() },
  oracleReport: { create: vi.fn() },
}));

// The BullMQ producer `main.ts` actually constructs. Mocking this module (and
// not the sibling `redis-submission-queue.ts` implementation, which the oracle
// entrypoint does not import) is what keeps these tests hermetic: the real
// queue dials Redis, so an un-mocked test both hangs and silently asserts
// against a mock that was never wired in.
const mockQueue = vi.hoisted(() => ({
  enqueue: vi.fn().mockResolvedValue(true),
  close: vi.fn().mockResolvedValue(undefined),
}));

const mockOracleService = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("../../src/services/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
}));

vi.mock("../../src/services/redis.js", () => ({
  redis: { disconnect: vi.fn() },
}));

vi.mock("../indexer/src/logger.js", () => ({
  createLogger: () => mockLogger,
}));

vi.mock("./oracle-config.js", () => ({
  loadOracleConfig: vi.fn(() => ({
    pollIntervalMs: 60_000,
    challengeWindowSeconds: 86_400,
    logLevel: "info",
    secretKey: "SECRETKEY",
  })),
}));

vi.mock("./oracle-service.js", () => ({
  OracleService: vi.fn().mockImplementation(function () {
    return mockOracleService;
  }),
}));

vi.mock("./primary-adapter.js", () => ({
  PrimaryAdapter: vi.fn(),
}));

vi.mock("./fallback-adapter.js", () => ({
  FallbackAdapter: vi.fn(),
}));

vi.mock("./signature-helper.js", () => ({
  signResolutionReport: vi.fn(() => ({
    payload: {
      marketId: "m1",
      outcome: true,
      timestamp: "2024-01-01T00:00:00Z",
    },
    signature: "sig",
    publicKey: "pub",
  })),
}));

vi.mock("../workers/src/oracle/bullmq-submission-queue.js", () => ({
  BullMQSubmissionQueue: vi.fn().mockImplementation(function () {
    return mockQueue;
  }),
}));

import { poll, createOverlapGuardedPoll } from "./main.js";
import { loadOracleConfig } from "./oracle-config.js";
import { signResolutionReport } from "./signature-helper.js";

const RESOLVED_RESULT = {
  outcome: true,
  confidence: 0.95,
  confidenceMetadata: { score: 0.95, method: "test" },
  source: "primary",
  sourceMetadata: { provider: "primary" },
  timestamp: "2024-01-01T00:00:00Z",
};

describe("apps/oracle/main poll()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (loadOracleConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      pollIntervalMs: 60_000,
      challengeWindowSeconds: 86_400,
      logLevel: "info",
      secretKey: "SECRETKEY",
    });
    mockQueue.enqueue.mockResolvedValue(true);
  });

  it("skips signing, report persistence, and enqueue when dry-run is enabled (#1146)", async () => {
    (loadOracleConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      pollIntervalMs: 60_000,
      challengeWindowSeconds: 86_400,
      logLevel: "info",
      secretKey: "SECRETKEY",
      dryRun: true,
    });
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market-1", oracleAddress: "GORACLE1" },
    ]);
    mockOracleService.resolve.mockResolvedValue(RESOLVED_RESULT);

    await poll();

    // The provider call and confidence gate still run...
    expect(mockOracleService.resolve).toHaveBeenCalledWith({
      marketId: "market-1",
      oracleAddress: "GORACLE1",
    });
    // ...but nothing reaches the money path.
    expect(signResolutionReport).not.toHaveBeenCalled();
    expect(mockPrisma.oracleReport.create).not.toHaveBeenCalled();
    expect(mockQueue.enqueue).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dry-run"),
      expect.objectContaining({ event: "oracle.dry_run_enabled" })
    );
  });

  it("resolves active markets, persists an OracleReport, and enqueues each result", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market-1", oracleAddress: "GORACLE1" },
    ]);
    mockOracleService.resolve.mockResolvedValue(RESOLVED_RESULT);

    await poll();

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    // `findMany` runs twice per poll: the batch query, then a fresh
    // lifecycle re-check per market before persisting. Both are scoped to
    // resolvable (ACTIVE) markets, and both exclude soft-deleted ones.
    expect(mockPrisma.market.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["ACTIVE"] },
          deletedAt: null,
        }),
      })
    );
    expect(mockOracleService.resolve).toHaveBeenCalledWith({
      marketId: "market-1",
      oracleAddress: "GORACLE1",
    });
    expect(mockPrisma.oracleReport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          marketId: "market-1",
          source: "GORACLE1",
          confidence: 0.95,
          candidateResolution: true,
        }),
      })
    );
    expect(mockQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { marketId: "market-1", oracleAddress: "GORACLE1" },
        status: "pending",
        attempts: 0,
        result: expect.objectContaining({
          signature: "sig",
          publicKey: "pub",
        }),
      })
    );
  });

  it("skips markets without an oracle address", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market-1", oracleAddress: null },
    ]);

    await poll();

    expect(mockOracleService.resolve).not.toHaveBeenCalled();
    expect(mockQueue.enqueue).not.toHaveBeenCalled();
  });

  it("persists the provider confidence score on the OracleReport row", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market-1", oracleAddress: "GORACLE1" },
    ]);
    mockOracleService.resolve.mockResolvedValue({
      ...RESOLVED_RESULT,
      confidence: 0.87,
    });

    await poll();

    expect(mockPrisma.oracleReport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          confidence: 0.87,
          source: "GORACLE1",
        }),
      })
    );
  });

  it("persists the confidence value from the fallback provider when primary fails", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market-1", oracleAddress: "GORACLE1" },
    ]);
    mockOracleService.resolve.mockResolvedValue({
      ...RESOLVED_RESULT,
      source: "fallback-1",
      confidence: 0.72,
    });

    await poll();

    expect(mockPrisma.oracleReport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          confidence: 0.72,
          source: "GORACLE1", // source is oracleAddress, not provider name
        }),
      })
    );
  });

  it("rejects an out-of-range confidence score instead of inserting the OracleReport", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market-1", oracleAddress: "GORACLE1" },
    ]);
    mockOracleService.resolve.mockResolvedValue({
      ...RESOLVED_RESULT,
      confidence: 1.5,
    });

    await poll();

    expect(mockPrisma.oracleReport.create).not.toHaveBeenCalled();
    expect(mockQueue.enqueue).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Failed to resolve market",
      expect.objectContaining({
        marketId: "market-1",
        error: expect.stringContaining("out of range"),
      })
    );
  });

  it("rejects a negative confidence score instead of inserting the OracleReport", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market-1", oracleAddress: "GORACLE1" },
    ]);
    mockOracleService.resolve.mockResolvedValue({
      ...RESOLVED_RESULT,
      confidence: -0.1,
    });

    await poll();

    expect(mockPrisma.oracleReport.create).not.toHaveBeenCalled();
    expect(mockQueue.enqueue).not.toHaveBeenCalled();
  });

  it("logs and continues when one market fails to resolve, without aborting the batch", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market-fail", oracleAddress: "GFAIL" },
      { id: "market-ok", oracleAddress: "GOK" },
    ]);
    mockOracleService.resolve
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce(RESOLVED_RESULT);

    await poll();

    expect(mockLogger.error).toHaveBeenCalledWith(
      "Failed to resolve market",
      expect.objectContaining({
        marketId: "market-fail",
        error: "provider unavailable",
      })
    );
    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(mockQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { marketId: "market-ok", oracleAddress: "GOK" },
      })
    );
  });

  it("throws when ORACLE_SECRET_KEY is not configured", async () => {
    (loadOracleConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      pollIntervalMs: 60_000,
      challengeWindowSeconds: 86_400,
      logLevel: "info",
      secretKey: undefined,
    });

    await expect(poll()).rejects.toThrow("ORACLE_SECRET_KEY is required");
    expect(mockPrisma.market.findMany).not.toHaveBeenCalled();
  });

  it("threads the caller's shutdown signal into every resolution (#1109/#1110)", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market-1", oracleAddress: "GORACLE1" },
    ]);
    mockOracleService.resolve.mockResolvedValue(RESOLVED_RESULT);
    const controller = new AbortController();

    await poll({ signal: controller.signal });

    // The adapters forward this signal into their in-flight `fetch`, so a
    // shutdown cancels a hung provider instead of waiting out its timeout.
    expect(mockOracleService.resolve).toHaveBeenCalledWith({
      marketId: "market-1",
      oracleAddress: "GORACLE1",
      signal: controller.signal,
    });
  });

  it("dials no provider and writes nothing once the caller has aborted", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market-1", oracleAddress: "GORACLE1" },
    ]);
    const controller = new AbortController();
    controller.abort(new Error("Oracle shutdown (SIGTERM)"));

    await poll({ signal: controller.signal });

    expect(mockOracleService.resolve).not.toHaveBeenCalled();
    expect(mockPrisma.oracleReport.create).not.toHaveBeenCalled();
    expect(mockQueue.enqueue).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Oracle poll aborted, skipping remaining markets",
      expect.objectContaining({
        event: "oracle.poll_aborted",
        marketId: "market-1",
      })
    );
  });

  it("stops the batch on a mid-cycle abort without reporting a provider fault", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market-abort", oracleAddress: "GABORT" },
      { id: "market-2", oracleAddress: "GOK" },
    ]);
    const controller = new AbortController();
    mockOracleService.resolve.mockImplementationOnce(async () => {
      controller.abort(new Error("Oracle shutdown (SIGTERM)"));
      const aborted = new Error("Operation aborted by caller");
      aborted.name = "AbortError";
      throw aborted;
    });

    await poll({ signal: controller.signal });

    // The aborted market is abandoned (no report, nothing enqueued) and the
    // remaining market is never dialled.
    expect(mockOracleService.resolve).toHaveBeenCalledTimes(1);
    expect(mockPrisma.oracleReport.create).not.toHaveBeenCalled();
    expect(mockQueue.enqueue).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Oracle poll aborted while resolving market",
      expect.objectContaining({
        event: "oracle.poll_aborted",
        marketId: "market-abort",
      })
    );
    // A deliberate cancellation must not be logged as a provider failure.
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      "Failed to resolve market",
      expect.anything()
    );
  });
});

describe("createOverlapGuardedPoll", () => {
  it("skips a tick that starts while a previous poll is still in flight", async () => {
    let resolveFirst: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const pollFn = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => Promise.resolve());

    const guardedPoll = createOverlapGuardedPoll(pollFn, mockLogger as any);

    const firstCall = guardedPoll();
    const secondCall = guardedPoll(); // fires while the first is still pending

    resolveFirst();
    await Promise.all([firstCall, secondCall]);

    expect(pollFn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Skipping oracle poll because a previous poll is active"
    );
  });

  it("allows the next tick to run once the previous poll has completed", async () => {
    const pollFn = vi.fn().mockResolvedValue(undefined);
    const guardedPoll = createOverlapGuardedPoll(pollFn, mockLogger as any);

    await guardedPoll();
    await guardedPoll();

    expect(pollFn).toHaveBeenCalledTimes(2);
  });

  it("catches and logs a poll failure instead of throwing", async () => {
    const pollFn = vi.fn().mockRejectedValue(new Error("provider down"));
    const guardedPoll = createOverlapGuardedPoll(pollFn, mockLogger as any);

    await expect(guardedPoll()).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith("Poll cycle failed", {
      error: "provider down",
    });
  });

  it("allows a poll to run again after a previous cycle failed", async () => {
    const pollFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce(undefined);
    const guardedPoll = createOverlapGuardedPoll(pollFn, mockLogger as any);

    await guardedPoll();
    await guardedPoll();

    expect(pollFn).toHaveBeenCalledTimes(2);
  });
});
