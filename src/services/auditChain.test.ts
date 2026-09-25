import { describe, it, expect } from "vitest";
import {
  computeAuditEntryHash,
  verifyAuditChainEvents,
  AUDIT_CHAIN_ROOT_HASH,
  type AuditChainEvent,
} from "./auditChain.js";

/** Build a well-formed chain of `n` events starting from the genesis hash. */
function buildChain(n: number): AuditChainEvent[] {
  const events: AuditChainEvent[] = [];
  let prevHash = AUDIT_CHAIN_ROOT_HASH;
  for (let i = 0; i < n; i++) {
    const payload = JSON.stringify({ tradeId: `trade-${i}`, seq: i });
    const entryHash = computeAuditEntryHash(payload, prevHash);
    events.push({ streamId: `${1000 + i}-0`, payload, prevHash, entryHash });
    prevHash = entryHash;
  }
  return events;
}

describe("verifyAuditChainEvents", () => {
  it("accepts an intact chain from genesis", () => {
    const result = verifyAuditChainEvents(buildChain(5));
    expect(result.valid).toBe(true);
    expect(result.totalEvents).toBe(5);
    expect(result.mismatchCount).toBe(0);
    expect(result.gapCount).toBe(0);
  });

  it("accepts an empty chain", () => {
    const result = verifyAuditChainEvents([]);
    expect(result.valid).toBe(true);
    expect(result.totalEvents).toBe(0);
  });

  it("detects payload tampering (entryHash no longer matches)", () => {
    const chain = buildChain(4);
    chain[2] = {
      ...chain[2],
      payload: chain[2].payload.replace("trade-2", "trade-HACKED"),
    };
    const result = verifyAuditChainEvents(chain);
    expect(result.valid).toBe(false);
    expect(result.mismatchCount).toBe(1);
    expect(result.errors[0].kind).toBe("hash_mismatch");
    expect(result.errors[0].streamId).toBe(chain[2].streamId);
  });

  // Issue #952: the whole point of a hash chain — an archived row that is
  // deleted or expires must be detectable even though every surviving row is
  // still internally consistent.
  it("detects a chain gap when an intermediate archived row is missing", () => {
    const chain = buildChain(6);
    const withHole = [...chain.slice(0, 3), ...chain.slice(4)]; // drop index 3

    const result = verifyAuditChainEvents(withHole);

    expect(result.valid).toBe(false);
    expect(result.gapCount).toBe(1);
    expect(result.mismatchCount).toBe(0); // every surviving row still hashes fine
    const gap = result.errors.find((e) => e.kind === "chain_gap");
    expect(gap).toBeDefined();
    expect(gap!.streamId).toBe(chain[4].streamId);
  });

  it("proves the naive per-row hash check alone would have missed the gap", () => {
    const chain = buildChain(6);
    const withHole = [...chain.slice(0, 3), ...chain.slice(4)];
    // Every remaining row: entryHash === sha256(payload + prevHash)
    for (const e of withHole) {
      expect(computeAuditEntryHash(e.payload, e.prevHash)).toBe(e.entryHash);
    }
  });

  it("flags a missing genesis when expectGenesis is true (full-market verify)", () => {
    const chain = buildChain(4).slice(1); // starts at index 1, prevHash != "0"
    const result = verifyAuditChainEvents(chain, { expectGenesis: true });
    expect(result.valid).toBe(false);
    expect(result.errors[0].kind).toBe("genesis");
  });

  it("does not flag genesis for a time-range slice (expectGenesis false)", () => {
    const chain = buildChain(4).slice(1);
    const result = verifyAuditChainEvents(chain, { expectGenesis: false });
    expect(result.valid).toBe(true);
    expect(result.gapCount).toBe(0);
  });

  it("still detects a gap inside a time-range slice", () => {
    const chain = buildChain(8);
    const slice = [chain[2], chain[3], chain[5], chain[6]]; // drop chain[4]
    const result = verifyAuditChainEvents(slice, { expectGenesis: false });
    expect(result.valid).toBe(false);
    expect(result.gapCount).toBe(1);
  });
});
