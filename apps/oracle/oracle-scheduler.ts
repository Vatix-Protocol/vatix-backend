/**
 * Oracle Scheduler
 *
 * Owns the oracle poll interval and the reliability policy around it:
 * validated configuration, jitter so replicas do not poll in lockstep,
 * overlap protection, cycle timeouts, and bounded back-off after repeated
 * failures.
 *
 * ## Invariants (#1110)
 *
 * 1. **A tick never overlaps a running cycle.** A cycle still running when
 *    the next tick fires is *skipped* (counted and logged), never run
 *    concurrently — two concurrent cycles would double-resolve markets and
 *    double-enqueue submissions.
 * 2. **The interval is validated, not trusted.** `ORACLE_POLL_INTERVAL_MS`
 *    must be an integer within `[MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS]`;
 *    anything else throws at startup rather than being silently clamped.
 * 3. **Repeated failures back off, bounded.** After `BACKOFF_THRESHOLD`
 *    consecutive failures the delay grows exponentially up to
 *    `MAX_POLL_BACKOFF_MS`, so a DB/RPC/provider outage is not retried at full
 *    speed forever. A single success resets the streak.
 * 4. **A cycle can never run unbounded.** A cycle exceeding `cycleTimeoutMs`
 *    is abandoned (its result discarded, a failure recorded), so a hung
 *    dependency cannot pin the scheduler forever.
 * 5. **The math is deterministic-testable.** `random` and `now` are
 *    injectable, so back-off and jitter are unit-testable without fake timers.
 *
 * @module apps/oracle/oracle-scheduler
 */

import {
  oraclePollConsecutiveFailures,
  oraclePollCycleDurationMs,
  oraclePollCyclesTotal,
} from "../../src/services/metrics.js";

/** Minimum allowed polling interval (5 seconds). */
export const MIN_POLL_INTERVAL_MS = 5_000;

/** Maximum allowed polling interval (1 hour). */
export const MAX_POLL_INTERVAL_MS = 3_600_000;

/** Recommended default polling interval (30 seconds). */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Number of consecutive failed cycles tolerated at the configured interval
 * before back-off kicks in. One or two failures are normal provider blips and
 * retrying promptly recovers fastest; a sustained outage needs back-off.
 */
export const BACKOFF_THRESHOLD = 3;

/** Upper bound on the backed-off delay, regardless of interval or streak. */
export const MAX_POLL_BACKOFF_MS = 300_000;

/** Multiplier applied per failure once past {@link BACKOFF_THRESHOLD}. */
export const BACKOFF_FACTOR = 2;

/** Largest jitter added to a delay, as a fraction of the computed delay. */
export const MAX_JITTER_RATIO = 0.2;

/**
 * Read and validate ORACLE_POLL_INTERVAL_MS from the environment.
 *
 * @param env - Environment map (defaults to `process.env`).
 * @returns Validated polling interval in milliseconds.
 * @throws {Error} If the value is present but not a positive integer, or
 *   outside the allowed bounds.
 */
export function getOraclePollIntervalMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env["ORACLE_POLL_INTERVAL_MS"];

  if (raw === undefined || raw === "") {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `ORACLE_POLL_INTERVAL_MS must be a positive integer, got: ${JSON.stringify(raw)}`
    );
  }

  if (value < MIN_POLL_INTERVAL_MS) {
    throw new Error(
      `ORACLE_POLL_INTERVAL_MS must be >= ${MIN_POLL_INTERVAL_MS} ms (lower safety bound), got: ${value}`
    );
  }

  if (value > MAX_POLL_INTERVAL_MS) {
    throw new Error(
      `ORACLE_POLL_INTERVAL_MS must be <= ${MAX_POLL_INTERVAL_MS} ms (upper safety bound), got: ${value}`
    );
  }

  return value;
}

/**
 * Compute the delay before the next poll cycle.
 *
 * Exponential back-off after {@link BACKOFF_THRESHOLD} consecutive failures,
 * clamped to {@link MAX_POLL_BACKOFF_MS}, plus up to {@link MAX_JITTER_RATIO}
 * of positive jitter so horizontally-scaled oracle replicas that failed at the
 * same moment do not retry in lockstep.
 *
 * @param intervalMs - The configured base interval.
 * @param consecutiveFailures - Failed cycles since the last success.
 * @param random - Jitter source in `[0, 1)`; injectable for tests.
 * @returns The delay in milliseconds, never shorter than the base delay.
 */
export function computePollDelayMs(
  intervalMs: number,
  consecutiveFailures: number,
  random: () => number = Math.random
): number {
  const safeFailures = Math.max(0, Math.floor(consecutiveFailures));
  const backoffSteps = Math.max(0, safeFailures - BACKOFF_THRESHOLD + 1);

  const backedOff = Math.min(
    intervalMs * BACKOFF_FACTOR ** backoffSteps,
    MAX_POLL_BACKOFF_MS
  );

  // Jitter only ever delays: a low random draw can never undercut the back-off
  // guarantee by producing a *shorter* delay than the computed base. A
  // non-finite draw (a broken or stubbed `Math.random`) is treated as "no
  // jitter" rather than poisoning the delay with NaN — a NaN here would make
  // `setTimeout` fire immediately, i.e. the exact hot-loop back-off prevents.
  const draw = random();
  const bounded = Number.isFinite(draw)
    ? Math.min(Math.max(draw, 0), 0.999_999)
    : 0;
  const jitter = backedOff * MAX_JITTER_RATIO * bounded;

  return Math.min(Math.round(backedOff + jitter), MAX_POLL_BACKOFF_MS);
}

/** Minimal logger surface the scheduler needs. */
export interface SchedulerLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Outcome of a single scheduled cycle. */
export type PollCycleOutcome = "success" | "failure" | "skipped";

export interface PollSchedulerConfig {
  /** Validated base interval in milliseconds. */
  intervalMs: number;
  /** The work performed on each cycle. Rejections are caught and recorded. */
  runCycle: () => Promise<void>;
  logger: SchedulerLogger;
  /**
   * Wall-clock ceiling for a single cycle. A cycle that exceeds it is
   * abandoned: its result is discarded and a failure is recorded. Defaults to
   * `MAX_POLL_BACKOFF_MS`.
   */
  cycleTimeoutMs?: number;
  /** Jitter source in `[0, 1)`. Injectable for deterministic tests. */
  random?: () => number;
  /** Clock source. Injectable so tests can advance time without waiting. */
  now?: () => number;
}

/**
 * Scheduler for the oracle poll loop. Owns tick timing, overlap protection,
 * cycle timeouts, and failure back-off.
 */
export class PollScheduler {
  private readonly intervalMs: number;
  private readonly runCycle: () => Promise<void>;
  private readonly logger: SchedulerLogger;
  private readonly cycleTimeoutMs: number;
  private readonly random: () => number;
  private readonly now: () => number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private inFlight = false;
  private consecutiveFailures = 0;

  constructor(config: PollSchedulerConfig) {
    if (
      !Number.isInteger(config.intervalMs) ||
      config.intervalMs < MIN_POLL_INTERVAL_MS ||
      config.intervalMs > MAX_POLL_INTERVAL_MS
    ) {
      throw new Error(
        `PollScheduler intervalMs must be an integer within [${MIN_POLL_INTERVAL_MS}, ${MAX_POLL_INTERVAL_MS}], got: ${config.intervalMs}`
      );
    }

    this.intervalMs = config.intervalMs;
    this.runCycle = config.runCycle;
    this.logger = config.logger;
    this.cycleTimeoutMs = config.cycleTimeoutMs ?? MAX_POLL_BACKOFF_MS;
    this.random = config.random ?? Math.random;
    this.now = config.now ?? Date.now;
  }

  /** Whether the scheduler has been started and not yet stopped. */
  isRunning(): boolean {
    return this.running;
  }

  /** Failed cycles since the last success — drives the back-off. */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Start scheduling. The first cycle runs immediately so a misconfigured
   * deployment fails fast at boot instead of idling for a full interval.
   * Subsequent cycles are chained on completion (never on a fixed
   * `setInterval`), so a slow cycle cannot build up a backlog of ticks.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    void this.tick();
  }

  /**
   * Stop scheduling. No further cycle is started. A cycle already in flight is
   * left to finish (it is bounded by `cycleTimeoutMs`); callers that need a
   * hard guarantee should also `await waitForIdle()`.
   */
  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Resolves once no cycle is in flight. */
  async waitForIdle(): Promise<void> {
    while (this.inFlight) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /**
   * Run one cycle and schedule the next. Exposed for tests; `start()` is the
   * normal entrypoint.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;

    if (this.inFlight) {
      // Invariant 1: never run two cycles at once.
      this.record("skipped");
      this.logger.warn(
        "Skipping oracle poll because a previous poll is active",
        {
          event: "oracle.poll_skipped_overlap",
          intervalMs: this.intervalMs,
        }
      );
      this.scheduleNext();
      return;
    }

    this.inFlight = true;
    const startedAt = this.now();

    try {
      await this.withCycleTimeout(this.runCycle());
      this.consecutiveFailures = 0;
      this.record("success");
      this.logger.info("Oracle poll cycle completed", {
        event: "oracle.poll_cycle_completed",
        durationMs: this.now() - startedAt,
      });
    } catch (error) {
      this.consecutiveFailures++;
      this.record("failure");
      this.logger.error("Poll cycle failed", {
        event: "oracle.poll_cycle_failed",
        error: error instanceof Error ? error.message : String(error),
        consecutiveFailures: this.consecutiveFailures,
        durationMs: this.now() - startedAt,
      });
    } finally {
      oraclePollCycleDurationMs.observe(Math.max(0, this.now() - startedAt));
      oraclePollConsecutiveFailures.set(this.consecutiveFailures);
      this.inFlight = false;
    }

    this.scheduleNext();
  }

  /**
   * Race a cycle against `cycleTimeoutMs`. A cycle that overruns is reported
   * as a failure and its result discarded, so the scheduler keeps making
   * progress (invariant 4) even when the underlying promise never settles.
   */
  private async withCycleTimeout(cycle: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Oracle poll cycle exceeded ${this.cycleTimeoutMs}ms and was abandoned`
            )
          ),
        this.cycleTimeoutMs
      );
      timer.unref?.();
    });

    try {
      await Promise.race([cycle, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private record(outcome: PollCycleOutcome): void {
    oraclePollCyclesTotal.labels(outcome).inc();
  }

  private scheduleNext(): void {
    if (this.stopped) return;

    const delayMs = computePollDelayMs(
      this.intervalMs,
      this.consecutiveFailures,
      this.random
    );

    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }
}
