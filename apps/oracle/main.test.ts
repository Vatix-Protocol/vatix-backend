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

const mockQueue = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  enqueue: vi.fn().mockResolvedValue(true),
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

vi.mock("../workers/src/oracle/redis-submission-queue.js", () => ({
  RedisSubmissionQueue: vi.fn().mockImplementation(function () {
    return mockQueue;
  }),
}));

import { poll, createOverlapGuardedPoll } from "./main.js";
import { loadOracleConfig } from "./oracle-config.js";

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
    mockQueue.initialize.mockResolvedValue(undefined);
    mockQueue.enqueue.mockResolvedValue(true);
  });

  it("resolves active markets, persists an OracleReport, and enqueues each result", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market-1", oracleAddress: "GORACLE1" },
    ]);
    mockOracleService.resolve.mockResolvedValue(RESOLVED_RESULT);

    await poll();

    expect(mockQueue.initialize).toHaveBeenCalledTimes(1);
    expect(mockPrisma.market.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "ACTIVE" } })
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
