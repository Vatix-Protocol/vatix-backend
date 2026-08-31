import type { Prisma } from "../../../../src/generated/prisma/client/index.js";
import {
  finalizationLockContentionTotal,
  finalizationLockFailuresTotal,
} from "../../../../src/services/metrics.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";

/** Row shape returned by the locking query — just enough to gate the transition. */
export interface LockedCandidateRow {
  id: string;
  status: string;
}

/**
 * Statuses that indicate some other worker has already finalized this
 * candidate. Used by {@link lockResolutionCandidateOrThrow} to distinguish
 * "lock acquired, but the row already moved on" (expected contention) from
 * a hard failure (DB unreachable, deadlock, statement timeout).
 */
const TERMINAL_STATUSES = new Set([
  "RESOLVED",
  "FINALIZED",
  "REJECTED",
  "CANCELLED",
]);

export class ResolutionLockError extends Error {
  constructor(
    public readonly candidateId: string,
    cause: unknown
  ) {
    super(
      `Failed to acquire resolution_candidates lock for candidate ${candidateId}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "ResolutionLockError";
  }
}

/**
 * Locks a single `resolution_candidates` row for the lifetime of the
 * enclosing transaction (`SELECT ... FOR UPDATE`).
 *
 * Both the finalization win path (job.ts) and the challenge/dispute win
 * path (challenge.ts) take this same lock — by candidate id, one row at a
 * time — before reading or writing `status`. Postgres serializes any two
 * transactions that lock the same row: whichever commits first wins, and
 * the second transaction sees the post-commit status once it acquires the
 * lock, so it can detect the conflict and abort instead of clobbering the
 * result. That shared lock order is what makes finalize and challenge
 * mutually exclusive instead of racing.
 */
export async function lockResolutionCandidate(
  tx: Prisma.TransactionClient,
  candidateId: string
): Promise<LockedCandidateRow | null> {
  const rows = await tx.$queryRaw<LockedCandidateRow[]>`
    SELECT id, status
    FROM resolution_candidates
    WHERE id = ${candidateId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Production-hardened wrapper around {@link lockResolutionCandidate}.
 *
 * Closes the gap where two replicas racing to finalize the same candidate
 * could silently no-op instead of surfacing the conflict: this throws
 * `ResolutionLockError` (fail-fast) whenever the lock query itself fails —
 * DB unreachable, deadlock detected, statement timeout — instead of letting
 * the caller treat a thrown error the same as "candidate not found". It
 * also distinguishes expected lock contention (row already moved to a
 * terminal status by the winning worker) from that hard failure, emitting
 * distinct metrics/logs with the candidate id as a correlation key for
 * either case. In non-production environments the same classification
 * happens but is logged at debug level only, so local/dev runs stay quiet.
 */
export async function lockResolutionCandidateOrThrow(
  tx: Prisma.TransactionClient,
  candidateId: string,
  logger?: ILogger
): Promise<LockedCandidateRow | null> {
  const isProduction = process.env.NODE_ENV === "production";

  let row: LockedCandidateRow | null;
  try {
    row = await lockResolutionCandidate(tx, candidateId);
  } catch (cause) {
    finalizationLockFailuresTotal.inc();
    const err = new ResolutionLockError(candidateId, cause);
    logger?.error("resolution_candidates lock acquisition failed", {
      candidateId,
      error: err.message,
    });
    // Fail-fast in every environment: a lock failure must never be
    // swallowed into a silent off-chain fallback, in prod or dev alike.
    throw err;
  }

  if (row && TERMINAL_STATUSES.has(row.status)) {
    finalizationLockContentionTotal.inc();
    const log = isProduction ? logger?.warn : logger?.debug;
    log?.call(logger, "resolution_candidates lock contention detected", {
      candidateId,
      status: row.status,
    });
  }

  return row;
}
