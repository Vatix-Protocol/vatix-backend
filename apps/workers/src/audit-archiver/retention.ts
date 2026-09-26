/**
 * Audit archiver retention policy (#1137).
 *
 * `trade_audit_events` grows without bound: every Redis trade-stream entry is
 * archived durably and nothing ever removes it. That is a silent availability
 * and disk-exhaustion risk on a money-path table, so the archiver needs an
 * explicit, operator-controlled retention window.
 *
 * Retention is **off by default** (`retentionDays: 0`) and must be opted into.
 * When enabled it deletes only the *oldest prefix* of archived rows per market.
 *
 * ## Invariants
 *
 * 1. **Opt-in, fail-closed.** `retentionDays <= 0` disables deletion entirely.
 *    A misconfigured or missing value never destroys audit history.
 * 2. **Prefix-only, per market.** Only a contiguous oldest run of rows is
 *    eligible. A row is never deleted while a *retained* row in the same market
 *    still chains to it via `prevHash`. Deleting a middle row would leave an
 *    undetectable hole — see `src/services/auditChain.ts`, where a missing row
 *    is reported as a `chain_gap`.
 * 3. **Never empty a market.** `minRetainPerMarket` (default 1) guarantees the
 *    chain still has a genesis-anchored head to verify against.
 * 4. **Bounded per run.** At most `batchSize` rows are selected per run so a
 *    large backlog is drained across many polls instead of one long lock-holding
 *    transaction.
 * 5. **Bounded time window.** Only rows archived strictly before
 *    `now - retentionDays` are eligible. Freshly archived rows are never
 *    candidates, so a purge can never race the in-flight archival of the
 *    current run.
 *
 * The plan is computed by a pure function so the policy is unit-testable
 * without a database, and the caller performs the actual deletes.
 *
 * @module apps/workers/src/audit-archiver/retention
 */

export interface RetentionPolicy {
  /**
   * Retention window in days. `0` (or negative) disables retention entirely
   * and the planner returns an empty plan. There is deliberately no "delete
   * everything" sentinel — a large window is expressed in days.
   */
  retentionDays: number;
  /** Maximum rows to delete in a single run. Must be >= 1. */
  batchSize: number;
  /**
   * Minimum rows to keep per market, regardless of age. Must be >= 1 so every
   * market retains a verifiable chain head.
   */
  minRetainPerMarket?: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

export interface RetentionPlan {
  /** Ids to delete. Empty when retention is disabled. */
  deleteIds: string[];
  /** True when retention is disabled; no deletes will be performed. */
  disabled: boolean;
  /** Cutoff applied to `archivedAt`, or undefined when disabled. */
  cutoff?: Date;
  /** Markets contributing at least one delete id (i.e. making progress). */
  marketCount: number;
  /** Rows skipped because they were still inside the retention window. */
  retainedByWindow: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Compute the retention cutoff, or `null` when retention is disabled.
 *
 * Exported so operators/tests can reason about the exact boundary: a row is
 * eligible only when `archivedAt < cutoff` (strictly older than the window).
 */
export function computeRetentionCutoff(
  retentionDays: number,
  now: Date
): Date | null {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return null;
  }
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}

/**
 * Build a bounded, prefix-only retention delete plan.
 *
 * @param candidates - Archived rows for consideration, in any order.
 * @param policy - Retention policy.
 * @returns A plan listing the ids that may be deleted. An empty `deleteIds`
 *   with `disabled: true` means retention is off; empty with `disabled: false`
 *   means nothing is currently eligible.
 */
export function planRetentionPurge(
  candidates: readonly RetentionCandidate[],
  policy: RetentionPolicy
): RetentionPlan {
  const now = policy.now ?? new Date();
  const cutoff = computeRetentionCutoff(policy.retentionDays, now);

  if (cutoff === null) {
    return {
      deleteIds: [],
      disabled: true,
      marketCount: 0,
      retainedByWindow: 0,
    };
  }

  const batchSize = Math.max(1, Math.floor(policy.batchSize));
  const minRetain = Math.max(1, Math.floor(policy.minRetainPerMarket ?? 1));

  // Group by market and sort oldest-first so we only ever consume a prefix.
  const byMarket = new Map<string, RetentionCandidate[]>();
  for (const row of candidates) {
    const bucket = byMarket.get(row.marketId);
    if (bucket) {
      bucket.push(row);
    } else {
      byMarket.set(row.marketId, [row]);
    }
  }

  const eligible: RetentionCandidate[] = [];
  let retainedByWindow = 0;

  for (const rows of byMarket.values()) {
    rows.sort((a, b) => {
      const delta = a.archivedAt.getTime() - b.archivedAt.getTime();
      // Tie-break on id for a stable, deterministic plan.
      return delta !== 0 ? delta : a.id.localeCompare(b.id);
    });

    // Never empty a market — the newest `minRetain` rows always survive.
    const deletable = rows.slice(0, Math.max(0, rows.length - minRetain));

    for (const row of deletable) {
      // Strictly older than the cutoff; a row exactly on the boundary is kept.
      if (row.archivedAt.getTime() >= cutoff.getTime()) {
        // Sorted ascending, so everything after this is newer still.
        retainedByWindow++;
        break;
      }
      eligible.push(row);
    }
  }

  // Bound the blast radius of a single run: reclaim the oldest history first
  // rather than favoring whichever market happened to be scanned first.
  eligible.sort((a, b) => {
    const delta = a.archivedAt.getTime() - b.archivedAt.getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
  const bounded = eligible.slice(0, batchSize);

  return {
    deleteIds: bounded.map((row) => row.id),
    disabled: false,
    cutoff,
    marketCount: new Set(bounded.map((row) => row.marketId)).size,
    retainedByWindow,
  };
}
