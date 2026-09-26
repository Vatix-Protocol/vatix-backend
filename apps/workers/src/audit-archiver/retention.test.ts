import { describe, it, expect } from "vitest";
import {
  computeRetentionCutoff,
  planRetentionPurge,
  type RetentionCandidate,
} from "./retention.js";

const NOW = new Date("2026-03-01T00:00:00.000Z");
const DAY = 86_400_000;

function row(
  id: string,
  marketId: string,
  ageDays: number
): RetentionCandidate {
  return {
    id,
    marketId,
    archivedAt: new Date(NOW.getTime() - ageDays * DAY),
  };
}

describe("computeRetentionCutoff (#1137)", () => {
  it("returns null when retention is disabled so nothing is ever deleted", () => {
    expect(computeRetentionCutoff(0, NOW)).toBeNull();
    expect(computeRetentionCutoff(-1, NOW)).toBeNull();
  });

  it("rejects non-finite windows rather than guessing", () => {
    expect(computeRetentionCutoff(Number.NaN, NOW)).toBeNull();
    expect(computeRetentionCutoff(Number.POSITIVE_INFINITY, NOW)).toBeNull();
  });

  it("shifts the cutoff back by the configured number of days", () => {
    expect(computeRetentionCutoff(30, NOW)?.toISOString()).toBe(
      new Date(NOW.getTime() - 30 * DAY).toISOString()
    );
  });
});

describe("planRetentionPurge (#1137)", () => {
  it("is disabled by default and deletes nothing", () => {
    const plan = planRetentionPurge([row("a", "m1", 9999)], {
      retentionDays: 0,
      batchSize: 100,
      now: NOW,
    });

    expect(plan.disabled).toBe(true);
    expect(plan.deleteIds).toEqual([]);
  });

  it("deletes only rows strictly older than the retention window", () => {
    const plan = planRetentionPurge(
      [
        row("old", "m1", 40), // 40d > 30d window -> eligible
        row("fresh", "m1", 10), // inside window, also the retained head
      ],
      { retentionDays: 30, batchSize: 100, now: NOW }
    );

    expect(plan.deleteIds).toEqual(["old"]);
  });

  it("counts rows skipped for being inside the window", () => {
    // minRetain=2 makes the two oldest rows deletable candidates, so the walk
    // actually reaches a row that is still inside the window.
    const plan = planRetentionPurge(
      [
        row("a", "m1", 40), // eligible
        row("b", "m1", 10), // inside window -> stops the walk
        row("c", "m1", 9), // retained head
        row("d", "m1", 8), // retained head
      ],
      { retentionDays: 30, batchSize: 100, minRetainPerMarket: 2, now: NOW }
    );

    expect(plan.deleteIds).toEqual(["a"]);
    // Sorted ascending: once `b` is inside the window, `c` and `d` are too, so
    // the planner stops walking rather than testing the remainder.
    expect(plan.retainedByWindow).toBe(1);
  });

  it("keeps a row sitting exactly on the cutoff boundary", () => {
    const plan = planRetentionPurge([row("edge", "m1", 30)], {
      retentionDays: 30,
      batchSize: 100,
      now: NOW,
    });

    expect(plan.deleteIds).toEqual([]);
  });

  it("never empties a market so the chain head stays verifiable", () => {
    const plan = planRetentionPurge([row("a", "m1", 100), row("b", "m1", 99)], {
      retentionDays: 1,
      batchSize: 100,
      now: NOW,
    });

    // Only the older of the two is purged; the newest row survives.
    expect(plan.deleteIds).toEqual(["a"]);
  });

  it("honours minRetainPerMarket", () => {
    const plan = planRetentionPurge(
      [row("a", "m1", 100), row("b", "m1", 99), row("c", "m1", 98)],
      {
        retentionDays: 1,
        batchSize: 100,
        minRetainPerMarket: 2,
        now: NOW,
      }
    );

    expect(plan.deleteIds).toEqual(["a"]);
  });

  it("keeps the deleted rows a contiguous prefix, never a middle hole", () => {
    // m1: a < b < c. Only `a` is old enough. Deleting `a` is safe; deleting `b`
    // would orphan `c`, which still chains to it via prevHash.
    const plan = planRetentionPurge(
      [row("a", "m1", 100), row("b", "m1", 2), row("c", "m1", 1)],
      { retentionDays: 30, batchSize: 100, now: NOW }
    );

    expect(plan.deleteIds).toEqual(["a"]);
  });

  it("bounds a single run by batchSize and reclaims oldest history first", () => {
    const plan = planRetentionPurge(
      [
        row("a", "m1", 100),
        row("b", "m1", 90),
        row("c", "m1", 80),
        row("d", "m1", 70),
        row("keep", "m1", 1),
      ],
      { retentionDays: 30, batchSize: 2, now: NOW }
    );

    expect(plan.deleteIds).toEqual(["a", "b"]);
    expect(plan.marketCount).toBe(1);
  });

  it("never deletes a row freshly archived in the current run", () => {
    const plan = planRetentionPurge([row("just-archived", "m1", 0)], {
      retentionDays: 1,
      batchSize: 100,
      now: NOW,
    });

    expect(plan.deleteIds).toEqual([]);
  });

  it("purges each market independently and reports the market count", () => {
    const plan = planRetentionPurge(
      [
        row("a1", "m1", 100),
        row("a2", "m1", 99), // retained head for m1
        row("b1", "m2", 100),
        row("b2", "m2", 98), // retained head for m2
        row("c1", "m3", 1), // inside window
        row("c2", "m3", 0), // retained head for m3
      ],
      { retentionDays: 30, batchSize: 100, now: NOW }
    );

    expect(plan.deleteIds.sort()).toEqual(["a1", "b1"]);
    expect(plan.marketCount).toBe(2);
  });

  it("is order-independent and deterministic regardless of input order", () => {
    const rows = [
      row("a", "m1", 100),
      row("b", "m1", 90),
      row("keep", "m1", 1),
    ];

    const forward = planRetentionPurge(rows, {
      retentionDays: 30,
      batchSize: 100,
      now: NOW,
    });
    const reversed = planRetentionPurge([...rows].reverse(), {
      retentionDays: 30,
      batchSize: 100,
      now: NOW,
    });

    expect(reversed.deleteIds).toEqual(forward.deleteIds);
  });

  it("is a no-op on an empty archive", () => {
    const plan = planRetentionPurge([], {
      retentionDays: 30,
      batchSize: 100,
      now: NOW,
    });

    expect(plan.disabled).toBe(false);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.marketCount).toBe(0);
  });
});
