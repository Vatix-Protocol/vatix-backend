# Oracle submission-worker confirmation hardening (Issue 4)

## Problem

`apps/workers/src/oracle/submission-worker.ts` (and the shared
`checkOnChainStatus` helper in `submission-reconciliation.ts` used on the
resubmit/reconcile path) treated a `getTransaction(hash).status === SUCCESS`
response as sufficient proof of confirmation. That trusts a single
status flag keyed only by the tx hash, with no cross-check against the
ledger metadata a genuinely-included transaction always carries — so a
malformed, truncated, or inconsistent RPC response (e.g. across a
multi-endpoint Horizon/Soroban RPC setup) could mark a submission
`CONFIRMED` before it was actually finalized on-chain.

Separately, the worker's off-chain fallback (used when no Stellar config
is present) let `NODE_ENV=production` boot and run with resolutions marked
`CONFIRMED` without ever touching the chain.

## What changed

- Added `isDefinitivelyConfirmed()` (exported from
  `submission-reconciliation.ts`): true only when `status === SUCCESS`
  **and** `ledger` is a positive finite number. Used by both
  `checkOnChainStatus()` (resubmit/reconcile path) and the poll loop in
  `submission-worker.ts#broadcastAndConfirm` (initial broadcast path), so
  the same standard applies everywhere a tx hash is checked for
  confirmation.
- `broadcastAndConfirm`'s poll loop now treats `SUCCESS` without ledger
  metadata as still-unconfirmed (logs a warning and keeps polling) instead
  of confirming immediately; it still falls through to the existing
  ambiguous/timeout path if this persists.
- `SubmissionWorker`'s constructor now throws immediately in
  `NODE_ENV=production` if no Stellar config is supplied, instead of
  silently constructing a worker that will mark oracle reports
  `CONFIRMED` without any on-chain check (defense in depth alongside
  `main.ts`'s existing `validateAndResolveStellarConfig` bootstrap check).
- Updated existing tests in `submission-reconciliation.test.ts` that
  previously mocked `{ status: "SUCCESS" }` without `ledger` (which would
  now correctly resolve to `AMBIGUOUS`, not `CONFIRMED`) to include the
  ledger field, and added new tests for `isDefinitivelyConfirmed` and the
  "SUCCESS without ledger" and "missing production config" cases directly.

## Why this closes the gap

The reported failure mode — "hash-only confirm marks CONFIRMED too early"
— is closed by requiring a second, independent piece of on-chain evidence
(ledger inclusion) before trusting a status flag keyed by hash alone, and
by removing the silent off-chain production fallback that let the whole
confirmation path be skipped in the first place.
