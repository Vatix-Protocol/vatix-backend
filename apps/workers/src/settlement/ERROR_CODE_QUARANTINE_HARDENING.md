# Settlement error-code retry/quarantine hardening (Issue 3)

## Problem

`apps/workers/src/settlement/error-codes.ts` classified signature failures
under the generic `STELLAR_TX_BAD_AUTH` bucket regardless of whether the
failure was a local, pre-submission signature verification failure
(`InvalidSignature` — the payload never reached the network) or an
on-chain rejection. Both were fatal already, but there was no distinct,
machine-readable code or metric for the local case, making it impossible
to alert specifically on "our signer/payload is broken" without parsing
message strings — and no explicit `shouldQuarantine` concept separate from
`isRetryable` for callers to express intent.

## What changed

- Added `INVALID_SIGNATURE` error code (fatal, non-retryable) to
  `SettlementErrorCode` / `ERROR_REGISTRY`.
- `classifySettlementError()` now checks for `error.name === "InvalidSignature"`
  or an `"invalid signature"` / `"invalidsignature"` message **before** the
  existing on-chain `tx_bad_auth` bucket, so local signature failures are
  distinguished without breaking the existing `tx_bad_auth` classification
  (regression test added for the overlap case).
- Added `shouldQuarantine(info)` (currently `!isRetryable(info)`, exported
  separately so call sites express intent rather than re-deriving it).
- `settlement-worker.ts` now calls `settlementErrorQuarantinedTotal.inc({code})`
  whenever `shouldQuarantine` is true, giving per-code visibility into what's
  being quarantined instead of retried.
- Added unit tests: local `InvalidSignature` classification (by `error.name`
  and by message), the `tx_bad_auth` regression guard, and `shouldQuarantine`
  behavior across statuses.
- Documented the new metric and how to use it operationally in
  `docs/runbooks/incident-runbook.md` (Incident 8).

## Why this closes the gap

Previously an `InvalidSignature` failure was fatal but invisible as its own
category — an operator watching aggregate retry/fatal counts had no way to
tell "the signer key is wrong" apart from any other fatal Stellar rejection
without reading raw logs. It's now a first-class code with its own
quarantine metric, so a broken signer surfaces immediately instead of only
showing up as background RPC noise from a job that retries until its
attempt budget is exhausted.
