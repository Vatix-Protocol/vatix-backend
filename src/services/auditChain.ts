import { createHash } from "crypto";

/**
 * Pure trade-audit hash-chain verification (issue #952).
 *
 * The audit archiver writes each Redis trade-stream entry to Postgres as a
 * `trade_audit_events` row carrying `prevHash` (the previous row's `entryHash`)
 * and `entryHash = sha256(payload + prevHash)`. Two independent things can go
 * wrong and both must be caught:
 *
 *  1. **Payload tampering** — a stored `payload` is edited. `entryHash` no
 *     longer matches `sha256(payload + prevHash)`.
 *  2. **Chain gap** — an intermediate row is deleted or expires (retention).
 *     Every surviving row is still internally consistent, so a naive per-row
 *     hash check reports "valid". Only comparing each row's `prevHash` against
 *     the *actual* preceding row's `entryHash` reveals the missing link.
 *
 * Detecting (2) is the entire point of a hash chain, so verification MUST do
 * the linkage check — otherwise the chain is decorative and archives that
 * expire without a restore drill leave an undetectable hole.
 */

export const AUDIT_CHAIN_ROOT_HASH = "0";

export function computeAuditEntryHash(
  payload: string,
  prevHash: string
): string {
  return createHash("sha256").update(`${payload}${prevHash}`).digest("hex");
}

export interface AuditChainEvent {
  streamId: string;
  payload: string;
  prevHash: string;
  entryHash: string;
}

export interface AuditChainError {
  streamId: string;
  reason: string;
  kind: "hash_mismatch" | "chain_gap" | "genesis";
}

export interface AuditChainVerificationResult {
  valid: boolean;
  totalEvents: number;
  /** Rows whose stored entryHash disagrees with sha256(payload + prevHash). */
  mismatchCount: number;
  /** Broken links: a prevHash that does not match the preceding entryHash. */
  gapCount: number;
  errors: AuditChainError[];
}

export interface VerifyAuditChainOptions {
  /**
   * When true the first event must chain from the genesis hash ("0"). Pass
   * false when the caller filtered by a time range and the slice legitimately
   * starts partway down the chain. Default: true.
   */
  expectGenesis?: boolean;
}

/**
 * Verify an ordered slice of audit-chain events. `events` MUST already be
 * sorted by `archivedAt` ascending (the archiver's insertion order).
 */
export function verifyAuditChainEvents(
  events: AuditChainEvent[],
  options: VerifyAuditChainOptions = {}
): AuditChainVerificationResult {
  const expectGenesis = options.expectGenesis ?? true;
  const errors: AuditChainError[] = [];
  let gapCount = 0;
  let mismatchCount = 0;

  let expectedPrevHash: string | null = expectGenesis
    ? AUDIT_CHAIN_ROOT_HASH
    : null;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // (1) payload integrity
    const recomputed = computeAuditEntryHash(event.payload, event.prevHash);
    if (recomputed !== event.entryHash) {
      mismatchCount++;
      errors.push({
        streamId: event.streamId,
        kind: "hash_mismatch",
        reason: `Hash mismatch: expected ${recomputed}, got ${event.entryHash}`,
      });
    }

    // (2) chain linkage — the check the old verifier was missing
    if (expectedPrevHash !== null && event.prevHash !== expectedPrevHash) {
      if (i === 0) {
        errors.push({
          streamId: event.streamId,
          kind: "genesis",
          reason: `First event does not chain from the genesis hash: prevHash ${event.prevHash}, expected ${expectedPrevHash}`,
        });
      } else {
        gapCount++;
        errors.push({
          streamId: event.streamId,
          kind: "chain_gap",
          reason: `Broken chain link: prevHash ${event.prevHash} does not match preceding entryHash ${expectedPrevHash} — an archived row is missing (deleted or expired)`,
        });
      }
    }

    expectedPrevHash = event.entryHash;
  }

  return {
    valid: errors.length === 0,
    totalEvents: events.length,
    mismatchCount,
    gapCount,
    errors,
  };
}
