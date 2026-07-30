import { randomUUID } from "crypto";
import { redis } from "../services/redis.js";
import {
  matchingLeaderGauge,
  matchingLeaseRenewFailuresTotal,
} from "../services/metrics.js";

/**
 * Single-writer enforcement for the matching engine (production-critical:
 * horizontal scale without fencing means two pods can both hydrate books and
 * accept orders against the same market, producing inconsistent books and
 * double fills).
 *
 * Every API process competes for one Redis-backed lease. Only the current
 * holder is allowed to match orders (see isMatchingLeader() gate in
 * matching-service.ts#placeOrder). The lease is renewed on a heartbeat well
 * inside its TTL; if renewal fails — because another instance took over, or
 * because Redis is unreachable — this instance fails closed: isLeader()
 * flips to false and in-memory books are invalidated so stale depth is never
 * served as authoritative.
 *
 * Fencing: acquisition mints a monotonically increasing token (Redis INCR).
 * isLeader() also checks a locally-tracked deadline mirroring the lease TTL,
 * so a partitioned instance that can no longer reach Redis to learn it lost
 * the lease still stops matching on its own once that deadline passes —
 * bounded by MATCHING_LEASE_TTL_MS regardless of heartbeat timing.
 */

const LOCK_KEY = "matching:leader:lock";
const FENCING_KEY = "matching:leader:fencing";

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Lease timing, configurable via environment variables:
 *   MATCHING_LEASE_TTL_MS            — lease expiry in Redis (default: 15000)
 *   MATCHING_LEASE_RENEW_INTERVAL_MS — heartbeat interval (default: 5000)
 * The renew interval must stay comfortably below the TTL so a couple of
 * missed heartbeats (GC pause, transient network blip) don't cause an
 * unnecessary handover.
 */
function loadLeaseConfig(): { ttlMs: number; renewIntervalMs: number } {
  return {
    ttlMs: parsePositiveInt("MATCHING_LEASE_TTL_MS", 15_000),
    renewIntervalMs: parsePositiveInt(
      "MATCHING_LEASE_RENEW_INTERVAL_MS",
      5_000
    ),
  };
}

export interface LeaderLeaseCallbacks {
  /** Fired when this instance transitions from non-leader to leader. */
  onAcquired?: (token: number) => void | Promise<void>;
  /** Fired when this instance transitions from leader to non-leader. */
  onLost?: (reason: string) => void | Promise<void>;
}

export class LeaderLease {
  readonly holderId: string = randomUUID();
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private token = 0; // 0 = "we do not currently hold the lease"
  private expiresAt = 0; // local wall-clock deadline mirroring Redis's TTL
  private timer: ReturnType<typeof setInterval> | null = null;
  private callbacks: LeaderLeaseCallbacks = {};
  private inFlightTick: Promise<void> | null = null;

  constructor() {
    const cfg = loadLeaseConfig();
    this.ttlMs = cfg.ttlMs;
    this.renewIntervalMs = cfg.renewIntervalMs;
    matchingLeaderGauge.set(0);
  }

  /**
   * True only if this instance currently holds the lease AND the locally
   * tracked deadline has not passed. This is the check the write path
   * (placeOrder) must call before enqueueing any fill — it never trusts a
   * cached "I'm the leader" flag past the lease's own TTL, so a partitioned
   * instance stops accepting orders on its own even if it cannot reach
   * Redis to confirm it lost the lease.
   */
  isLeader(): boolean {
    return this.token > 0 && Date.now() < this.expiresAt;
  }

  /** Current fencing token, or null when not the leader. */
  getToken(): number | null {
    return this.isLeader() ? this.token : null;
  }

  /**
   * Begin competing for the lease: attempts acquisition immediately, then
   * heartbeats on an interval. Safe to call once per process; a second call
   * is a no-op while already running.
   */
  async start(callbacks: LeaderLeaseCallbacks = {}): Promise<void> {
    this.callbacks = callbacks;
    if (this.timer) return;

    await this.tick();

    this.timer = setInterval(() => {
      void this.tick();
    }, this.renewIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stops the heartbeat loop without releasing the lease in Redis. */
  stopHeartbeat(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Graceful shutdown: stop heartbeating and best-effort release the lease
   * in Redis if still held, so the next holder doesn't wait out the full
   * TTL. Never throws — release is best-effort, TTL expiry is the backstop.
   */
  async release(): Promise<void> {
    this.stopHeartbeat();
    if (this.token > 0) {
      const { token, holderId } = this;
      this.setNotLeader();
      try {
        await redis.releaseLeaseIfHeld(LOCK_KEY, holderId, token);
      } catch (error) {
        console.error(
          { service: "matching-leader-lease", err: error },
          "Failed to release matching leader lease on shutdown"
        );
      }
    }
  }

  private setNotLeader(): void {
    this.token = 0;
    this.expiresAt = 0;
    matchingLeaderGauge.set(0);
  }

  private async tick(): Promise<void> {
    // Coalesce overlapping ticks (e.g. a slow renewal still in flight when
    // the next interval fires) into a single in-progress attempt.
    if (this.inFlightTick) return this.inFlightTick;
    this.inFlightTick = this.doTick();
    try {
      await this.inFlightTick;
    } finally {
      this.inFlightTick = null;
    }
  }

  private async doTick(): Promise<void> {
    // Fail closed on our own clock: if the locally tracked deadline has
    // already passed, treat the lease as lost before even attempting a
    // network call — do not let a slow/unreachable Redis extend how long we
    // believe we are still the leader.
    if (this.token > 0 && Date.now() >= this.expiresAt) {
      this.handleLoss("local lease deadline passed before renewal succeeded");
    }

    const wasLeader = this.isLeader();

    try {
      const result = await redis.acquireOrRenewLease(
        LOCK_KEY,
        FENCING_KEY,
        this.holderId,
        this.ttlMs,
        this.token
      );

      if (result > 0) {
        this.token = result;
        this.expiresAt = Date.now() + this.ttlMs;
        matchingLeaderGauge.set(1);
        if (!wasLeader) {
          console.info(
            JSON.stringify({
              ts: new Date().toISOString(),
              level: "info",
              component: "matching-leader-lease",
              message: "Acquired matching leader lease",
              holderId: this.holderId,
              token: result,
            })
          );
          await this.callbacks.onAcquired?.(result);
        }
      } else {
        matchingLeaseRenewFailuresTotal.inc();
        this.handleLoss("lease is held by another instance");
      }
    } catch (error) {
      matchingLeaseRenewFailuresTotal.inc();
      console.error(
        {
          service: "matching-leader-lease",
          err: error instanceof Error ? error.message : String(error),
        },
        "Failed to acquire/renew matching leader lease"
      );
      // Redis being unreachable does not by itself demote us — the local
      // deadline check at the top of doTick() is what enforces fail-closed
      // behavior once the TTL we last renewed for actually elapses.
    }
  }

  private handleLoss(reason: string): void {
    if (this.token === 0) return; // already not leader, avoid duplicate onLost
    this.setNotLeader();
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        component: "matching-leader-lease",
        message: "Lost matching leader lease",
        holderId: this.holderId,
        reason,
      })
    );
    void this.callbacks.onLost?.(reason);
  }
}

export const leaderLease = new LeaderLease();
