# Finalization resolutionLock hardening (Issue 1)

## Problem

`apps/workers/src/finalization/resolutionLock.ts` acquired the
`resolution_candidates` row lock (`SELECT ... FOR UPDATE`) but had no
explicit handling for the lock query itself failing (DB unreachable,
deadlock, statement timeout). A thrown error there was indistinguishable
from any other error in the caller's `try/catch`, so there was no
fail-fast guarantee and no observability into lock contention between two
replicas racing to finalize the same candidate.

## What changed

- Added `lockResolutionCandidateOrThrow()` in `resolutionLock.ts`: wraps
  the existing `lockResolutionCandidate()` query, and:
  - Throws a typed `ResolutionLockError` (with the candidate id) if the
    lock query itself fails — in **every** environment, not just
    production, because a lock failure must never be swallowed into a
    silent no-op/off-chain fallback.
  - Detects when the row is already in a terminal status
    (`RESOLVED`/`FINALIZED`/`REJECTED`/`CANCELLED`) and logs that as
    contention (`warn` in production, `debug` otherwise) rather than a
    hard error — this is the expected "other worker won the race" case.
  - Emits `vatix_finalization_lock_contention_total` and
    `vatix_finalization_lock_failures_total` counters
    (`src/services/metrics.ts`) for dashboards/alerts.
- Wired `job.ts` (finalization win path) and `challenge.ts`
  (challenge/dispute win path) to call the new function instead of the raw
  one, passing their existing logger through for correlation.
- Added `resolutionLock.test.ts` covering: lock-query failure → throws and
  logs error; failure is not environment-gated; terminal-status row →
  contention warning, not an error; non-terminal row → no contention log.
- Added a new "Incident 8" section to
  `docs/runbooks/incident-runbook.md` describing the new metrics and how
  to distinguish lock contention from a genuine double-finalize.

## Why this closes the gap

Previously, a lock acquisition failure (e.g. a DB deadlock between two
replicas' finalize/challenge transactions) could be caught upstream and
treated the same as "candidate not eligible", silently dropping the
finalization instead of surfacing it. `lockResolutionCandidateOrThrow`
makes that failure loud (typed error + metric + log) and keeps the
existing serialization guarantee (Postgres row lock) as the sole source of
truth for who wins the race.
