/**
 * Oracle Boot Flow Tests
 *
 * Covers apps/oracle/main.ts's poll() — the per-cycle
 * fetch-markets -> resolve -> sign -> persist -> enqueue pipeline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockPrisma = {
  market: { findMany: vi.fn() },
  oracleReport: { create: vi.fn() },
};

const mockQueue = {
  initialize: vi.fn().mockResolvedValue(undefined),
  enqueue: vi.fn().mockResolvedValue(true),
};

const mockOracleService = {
  resolve: vi.fn(),
};

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
  OracleService: vi.fn(() => mockOracleService),
}));

vi.mock("./primary-adapter.js", () => ({
  PrimaryAdapter: vi.fn(),
}));

vi.mock("./fallback-adapter.js", () => ({
  FallbackAdapter: vi.fn(),
}));

vi.mock("./signature-helper.js", () => ({
  signResolutionReport: vi.fn(() => ({
    payload: { marketId: "m1", outcome: true, timestamp: "2024-01-01T00:00:00Z" },
    signature: "sig",
    publicKey: "pub",
  })),
}));

vi.mock("../workers/src/oracle/redis-submission-queue.js", () => ({
  RedisSubmissionQueue: vi.fn(() => mockQueue),
}));

import { poll } from "./main.js";
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
