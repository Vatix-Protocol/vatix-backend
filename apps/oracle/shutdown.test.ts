/**
 * Oracle graceful shutdown tests (#1139)
 *
 * Covers the teardown sequence in apps/oracle/main.ts's bootstrap(): signal
 * validation, in-flight poll draining, and a bounded hard timeout.
 *
 * The `createShutdown` helper itself is covered by its own suite; these tests
 * assert that the oracle wires it up correctly — drain-before-close ordering and
 * an enforced timeout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockPrisma = vi.hoisted(() => ({
  market: { findMany: vi.fn().mockResolvedValue([]) },
  oracleReport: { create: vi.fn() },
}));

const mockQueue = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  enqueue: vi.fn().mockResolvedValue(true),
  close: vi.fn().mockResolvedValue(undefined),
}));

const mockDisconnectPrisma = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
);
const mockRedisDisconnect = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
);

// Captures the ShutdownConfig handed to createShutdown so tests can invoke the
// registered teardown callbacks directly, in order, without sending real signals.
const captured = vi.hoisted(() => ({
  config: null as null | {
    timeoutMs?: number;
    component?: string;
    teardown?: Array<() => Promise<void>>;
  },
}));

vi.mock("../../packages/shared/src/shutdown.js", () => ({
  createShutdown: vi.fn((_logger: unknown, config: typeof captured.config) => {
    captured.config = config;
    // Return a no-op handler; the real process-level exit is out of scope here
    // and would kill the test runner.
    return vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock("../../src/services/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
  disconnectPrisma: mockDisconnectPrisma,
}));

vi.mock("../../src/services/redis.js", () => ({
  redis: { disconnect: mockRedisDisconnect },
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
    primaryTimeoutMs: 5_000,
    fallbackTimeoutMs: 5_000,
  })),
}));

vi.mock("./oracle-service.js", () => ({
  OracleService: vi.fn().mockImplementation(function () {
    return { resolve: vi.fn() };
  }),
}));

vi.mock("./primary-adapter.js", () => ({ PrimaryAdapter: vi.fn() }));
vi.mock("./fallback-adapter.js", () => ({ FallbackAdapter: vi.fn() }));
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

import { bootstrap, ORACLE_SHUTDOWN_TIMEOUT_MS } from "./main.js";

/** Run every registered teardown callback in order. */
const runTeardown = async () => {
  const teardown = captured.config?.teardown ?? [];
  for (const fn of teardown) await fn();
};

describe("oracle graceful shutdown (#1139)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.config = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers a shutdown handler with a bounded hard timeout", async () => {
    await bootstrap();

    expect(captured.config).not.toBeNull();
    // A bounded timeout is the core fix: without it a hung queue.close() or
    // stalled provider call wedges the process until SIGKILL.
    expect(captured.config?.timeoutMs).toBe(ORACLE_SHUTDOWN_TIMEOUT_MS);
    expect(ORACLE_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("closes the submission queue, prisma and redis during teardown", async () => {
    await bootstrap();
    await runTeardown();

    expect(mockQueue.close).toHaveBeenCalledTimes(1);
    expect(mockDisconnectPrisma).toHaveBeenCalledTimes(1);
    expect(mockRedisDisconnect).toHaveBeenCalledTimes(1);
  });

  it("stops the scheduler before closing any dependency", async () => {
    await bootstrap();
    const spy = vi.spyOn(global, "clearInterval");

    await runTeardown();

    // clearInterval must run first so no new poll starts against a closing DB.
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueue.close.mock.invocationCallOrder[0]
    );
    spy.mockRestore();
  });

  it("closes the submission queue only after an in-flight poll has drained", async () => {
    await bootstrap();
    expect(captured.config).not.toBeNull();

    // Gate the *next* poll so it is genuinely mid-flight when the signal lands.
    // The initial poll already completed (bootstrap awaited it), so the interval
    // tick is the only way to have a poll in flight during teardown.
    let releasePoll: () => void = () => {};
    const pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    mockPrisma.market.findMany.mockImplementation(async () => {
      await pollGate;
      return [];
    });

    // Fire the interval tick; the guarded poll starts and blocks on the gate.
    await vi.advanceTimersByTimeAsync(60_000);

    const teardownPromise = runTeardown();

    // The queue must still be open while the poll is mid-flight.
    expect(mockQueue.close).not.toHaveBeenCalled();

    releasePoll();
    await teardownPromise;

    expect(mockQueue.close).toHaveBeenCalledTimes(1);
  });

  it("handles a signal arriving with no poll in flight", async () => {
    await bootstrap();
    mockPrisma.market.findMany.mockResolvedValue([]);

    await expect(runTeardown()).resolves.toBeUndefined();
    expect(mockQueue.close).toHaveBeenCalledTimes(1);
  });
});
