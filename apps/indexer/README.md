# Indexer

The indexer consumes Stellar ledger events and projects them into the
backend read models. It is the source of truth for ledger-derived state
(balances, swaps, settlement) and must fail closed whenever that source
of truth is unreachable.

## Gap detection

`src/gapDetector.ts` detects missing ledger ranges in the ingested event
stream. It is keyed on `ledgerSeq:eventIndex` so that replayed or
concurrent detection requests are idempotent.

### Invariants

- **Contiguous ranges produce no gap.** A stream with no missing
  `ledgerSeq` values reports `hasGap: false`.
- **Single and multi-ledger gaps are reported.** Any missing
  `ledgerSeq` between the observed minimum and maximum is surfaced with
  its `from`/`to` bounds.
- **Boundary gaps are reported.** Missing ledgers at the start or end of
  the observed window are included.
- **Adversarial and duplicate inputs are rejected or deduplicated.**
  Out-of-order, duplicated, and malformed entries never produce a false
  "no gap" result.
- **Fail closed on dependency outage.** If the RPC/DB/Redis source of
  truth is unreachable, detection must not report `hasGap: false`; it
  returns a stable error code instead.

### Error codes

| Code | Meaning |
| --- | --- |
| `GAP_DETECTION_SOURCE_UNAVAILABLE` | Source of truth (RPC/DB/Redis) unreachable; fail closed. |
| `GAP_DETECTION_INVALID_INPUT` | Malformed or adversarial input rejected. |
| `GAP_DETECTION_UNAUTHORIZED` | Caller lacks the required role. |

Every detection result carries a `correlationId` for tracing across the
indexer and backend logs. Logs and metrics never include secrets or raw
credentials.

### Fixtures

Deterministic vectors live in `fixtures/gap-detection-vectors.json` and
cover contiguous ranges, single/multi-ledger gaps, boundary gaps, and
adversarial/duplicate inputs. Unit tests in `src/gapDetector.test.ts`
assert the invariants above, including auth and idempotency negatives
(replayed and concurrent detection requests).

### Rollback

Gap detection is read-only and does not mutate money-path state. If a
regression is detected, disable the detector via its feature flag and
fall back to the previous behavior; no mainnet state is affected.

## Stellar Wave contributors

See `SECURITY.md` for the deny-by-default policy on privileged surfaces
and the rate-limit/authorization requirements for every external
entrypoint. New privileged surfaces must be authorized and rate-limited
before landing.
