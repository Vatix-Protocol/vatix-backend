import type { Prisma } from "../../../../src/generated/prisma/client/index.js";

/** Row shape returned by the locking query — just enough to gate the transition. */
export interface LockedCandidateRow {
  id: string;
  status: string;
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
