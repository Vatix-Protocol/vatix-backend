import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PollScheduler,
  computePollDelayMs,
  getOraclePollIntervalMs,
  BACKOFF_FACTOR,
  BACKOFF_THRESHOLD,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_JITTER_RATIO,
  MAX_POLL_BACKOFF_MS,
  MAX_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
} from "./oracle-scheduler.js";
import {
  oraclePollConsecutiveFailures,
  oraclePollCyclesTotal,
} from "../../src/services/metrics.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("getOraclePollIntervalMs", () => {
  it("returns the documented default when unset", () => {
    expect(getOraclePollIntervalMs({})).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it("returns the default when set to an empty string", () => {
    expect(getOraclePollIntervalMs({ ORACLE_POLL_INTERVAL_MS: "" })).toBe(
      DEFAULT_POLL_INTERVAL_MS
    );
  });

  it("accepts a value inside the bounds", () => {
    expect(getOraclePollIntervalMs({ ORACLE_POLL_INTERVAL_MS: "60000" })).toBe(
      60_000
    );
  });

  it("rejects a value below the lower safety bound", () => {
    expect(() =>
      getOraclePollIntervalMs({ ORACLE_POLL_INTERVAL_MS: "1000" })
    ).toThrow(/lower safety bound/);
  });

  it("rejects a value above the upper safety bound", () => {
    expect(() =>
      getOraclePollIntervalMs({ ORACLE_POLL_INTERVAL_MS: "3600001" })
    ).toThrow(/upper safety bound/);
  });

  it("rejects a non-integer value", () => {
    expect(() =>
      getOraclePollIntervalMs({ ORACLE_POLL_INTERVAL_MS: "30000.5" })
    ).toThrow(/positive integer/);
  });

  it("rejects a non-numeric value", () => {
    expect(() =>
      getOraclePollIntervalMs({ ORACLE_POLL_INTERVAL_MS: "soon" })
    ).toThrow(/positive integer/);
  });
});

describe("computePollDelayMs (#1110)", () => {
  const noJitter = () => 0;

  it("returns the interval for a healthy scheduler", () => {
    expect(computePollDelayMs(30_000, 0, noJitter)).toBe(30_000);
  });

  it("does not back off before the failure threshold", () => {
    for (let failures = 1; failures < BACKOFF_THRESHOLD; failures++) {
      expect(computePollDelayMs(30_000, failures, noJitter)).toBe(30_000);
    }
  });

  it("doubles the interval once the failure threshold is reached", () => {
    expect(computePollDelayMs(30_000, BACKOFF_THRESHOLD, noJitter)).toBe(
      30_000 * BACKOFF_FACTOR
    );
  });

  it("grows exponentially with the failure streak", () => {
    expect(computePollDelayMs(30_000, BACKOFF_THRESHOLD + 2, noJitter)).toBe(
      30_000 * BACKOFF_FACTOR ** 3
    );
  });

  it("clamps the delay at MAX_POLL_BACKOFF_MS no matter how long the outage", () => {
    expect(computePollDelayMs(30_000, 50, noJitter)).toBe(MAX_POLL_BACKOFF_MS);
    expect(computePollDelayMs(3_600_000, 50, noJitter)).toBe(
      MAX_POLL_BACKOFF_MS
    );
  });

  it("adds bounded jitter so replicas do not retry in lockstep", () => {
    const base = 30_000;
    expect(computePollDelayMs(base, 0, () => 0.5)).toBe(
      Math.round(base * (1 + MAX_JITTER_RATIO * 0.5))
    );
  });

  it("never returns a delay shorter than the computed base", () => {
    // A pathological random source must not undercut the back-off guarantee.
    for (const draw of [0, -1, Number.NaN, 5]) {
      expect(computePollDelayMs(30_000, 10, () => draw)).toBeGreaterThanOrEqual(
        Math.min(30_000 * BACKOFF_FACTOR ** 8, MAX_POLL_BACKOFF_MS)
      );
    }
  });

  it("keeps the delay inside the global ceiling even with maximum jitter", () => {
    expect(computePollDelayMs(MAX_POLL_INTERVAL_MS, 20, () => 1)).toBe(
      MAX_POLL_BACKOFF_MS
    );
  });
});

describe("PollScheduler (#1110)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects an interval outside the validated bounds", () => {
    expect(
      () =>
        new PollScheduler({
          intervalMs: MIN_POLL_INTERVAL_MS - 1,
          runCycle: async () => {},
          logger: makeLogger(),
        })
    ).toThrow(/must be an integer within/);
  });

  it("runs one cycle per tick and records it as a success", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const runCycle = vi.fn().mockResolvedValue(undefined);

    const scheduler = new PollScheduler({
      intervalMs: MIN_POLL_INTERVAL_MS,
      runCycle,
      logger,
      random: () => 0,
    });

    await scheduler.tick();
    scheduler.stop();

    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(scheduler.getConsecutiveFailures()).toBe(0);
  });

  it("never runs two cycles concurrently", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    let release: () => void = () => {};
    const runCycle = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const scheduler = new PollScheduler({
      intervalMs: MIN_POLL_INTERVAL_MS,
      runCycle,
      logger,
      random: () => 0,
    });

    const first = scheduler.tick();
    // A tick that lands while the first is still running must be dropped.
    await scheduler.tick();
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Skipping oracle poll because a previous poll is active",
      expect.objectContaining({ event: "oracle.poll_skipped_overlap" })
    );

    release();
    await first;
    scheduler.stop();
  });

  it("allows the next cycle after the previous one finished", async () => {
    vi.useFakeTimers();
    const runCycle = vi.fn().mockResolvedValue(undefined);
    const scheduler = new PollScheduler({
      intervalMs: MIN_POLL_INTERVAL_MS,
      runCycle,
      logger: makeLogger(),
      random: () => 0,
    });

    await scheduler.tick();
    await scheduler.tick();
    scheduler.stop();

    expect(runCycle).toHaveBeenCalledTimes(2);
  });

  it("records a failure and keeps the scheduler alive when a cycle throws", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const runCycle = vi.fn().mockRejectedValue(new Error("db down"));

    const scheduler = new PollScheduler({
      intervalMs: MIN_POLL_INTERVAL_MS,
      runCycle,
      logger,
      random: () => 0,
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(scheduler.getConsecutiveFailures()).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Poll cycle failed",
      expect.objectContaining({ event: "oracle.poll_cycle_failed" })
    );

    scheduler.stop();
  });

  it("resets the failure streak after a success", async () => {
    vi.useFakeTimers();
    const runCycle = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(undefined);

    const scheduler = new PollScheduler({
      intervalMs: MIN_POLL_INTERVAL_MS,
      runCycle,
      logger: makeLogger(),
      random: () => 0,
    });

    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.getConsecutiveFailures()).toBe(2);

    await scheduler.tick();
    expect(scheduler.getConsecutiveFailures()).toBe(0);
    scheduler.stop();
  });

  it("abandons a cycle that exceeds cycleTimeoutMs so the scheduler cannot be pinned", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const runCycle = vi
      .fn()
      .mockImplementation(() => new Promise<void>(() => {}));

    const scheduler = new PollScheduler({
      intervalMs: MIN_POLL_INTERVAL_MS,
      cycleTimeoutMs: 10_000,
      runCycle,
      logger,
      random: () => 0,
    });

    const pending = scheduler.tick();
    await vi.advanceTimersByTimeAsync(10_100);
    await pending;
    scheduler.stop();

    expect(scheduler.getConsecutiveFailures()).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Poll cycle failed",
      expect.objectContaining({
        error: expect.stringContaining("was abandoned"),
      })
    );
  });

  it("stops scheduling after stop() and runs no further cycles", async () => {
    vi.useFakeTimers();
    const runCycle = vi.fn().mockResolvedValue(undefined);
    const scheduler = new PollScheduler({
      intervalMs: MIN_POLL_INTERVAL_MS,
      runCycle,
      logger: makeLogger(),
      random: () => 0,
    });

    scheduler.start();
    await scheduler.tick();
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(MIN_POLL_INTERVAL_MS * 10);
    // start() kicked off one cycle; stop() must prevent any further ones.
    expect(runCycle).toHaveBeenCalledTimes(1);
  });

  it("waitForIdle resolves once the in-flight cycle has finished", async () => {
    vi.useFakeTimers();
    const runCycle = vi.fn().mockResolvedValue(undefined);
    const scheduler = new PollScheduler({
      intervalMs: MIN_POLL_INTERVAL_MS,
      runCycle,
      logger: makeLogger(),
      random: () => 0,
    });

    await scheduler.tick();
    await expect(scheduler.waitForIdle()).resolves.toBeUndefined();
    scheduler.stop();
  });

  it("emits the poll-cycle and consecutive-failure metrics", async () => {
    vi.useFakeTimers();
    const before = await cycleCount("failure");
    const beforeGauge = (await oraclePollConsecutiveFailures.get()).values[0]
      ?.value;

    const scheduler = new PollScheduler({
      intervalMs: MIN_POLL_INTERVAL_MS,
      runCycle: vi.fn().mockRejectedValue(new Error("rpc down")),
      logger: makeLogger(),
      random: () => 0,
    });

    await scheduler.tick();
    scheduler.stop();

    expect(await cycleCount("failure")).toBe(before + 1);
    expect((await oraclePollConsecutiveFailures.get()).values[0]?.value).toBe(
      (beforeGauge ?? 0) + 1
    );
  });
});

/** Read the current `outcome` series value from the poll-cycle counter. */
async function cycleCount(outcome: string): Promise<number> {
  const snapshot = await oraclePollCyclesTotal.get();
  const match = snapshot.values.find((v) => v.labels.outcome === outcome);
  return match?.value ?? 0;
}
