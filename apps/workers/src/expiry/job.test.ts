import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExpiryJob } from "./job.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";

function createLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ILogger;
}

function createPrismaMock(markets: { id: string; endTime: Date }[]) {
  return {
    market: {
      findMany: vi.fn().mockResolvedValue(markets),
      findUnique: vi.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        const market = markets.find((m) => m.id === where.id);
        return Promise.resolve(
          market ? { ...market, status: "ACTIVE", deletedAt: null } : null
        );
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    order: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    userPosition: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn(prismaMock)
    ),
  };
}

let prismaMock: ReturnType<typeof createPrismaMock>;

describe("ExpiryJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports truncation and unprocessed count when maxRunMs is exceeded", async () => {
    const markets = [
      { id: "m1", endTime: new Date("2020-01-01T00:00:00Z") },
      { id: "m2", endTime: new Date("2020-01-01T00:00:00Z") },
      { id: "m3", endTime: new Date("2020-01-01T00:00:00Z") },
    ];
    prismaMock = createPrismaMock(markets);

    const logger = createLogger();
    const job = new ExpiryJob(prismaMock as never, logger, { maxRunMs: 1000 });

    // Advance the clock past maxRunMs before the loop processes any market.
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const runPromise = job.run();
    vi.setSystemTime(new Date("2024-01-01T00:00:02Z"));
    const result = await runPromise;

    expect(result.truncated).toBe(true);
    expect(result.unprocessedCount).toBe(markets.length);
    expect(result.totalCandidates).toBe(markets.length);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("does not report truncation when the run completes within maxRunMs", async () => {
    const markets = [{ id: "m1", endTime: new Date("2020-01-01T00:00:00Z") }];
    prismaMock = createPrismaMock(markets);

    const logger = createLogger();
    const job = new ExpiryJob(prismaMock as never, logger, { maxRunMs: 0 });

    const result = await job.run();

    expect(result.truncated).toBe(false);
    expect(result.unprocessedCount).toBe(0);
  });
});
