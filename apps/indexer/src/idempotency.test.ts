import { describe, it, expect } from "vitest";
import { generateIdempotencyKey } from "./idempotency.js";

describe("generateIdempotencyKey", () => {
  const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

  it("produces different keys when only the ledger differs", () => {
    const a = generateIdempotencyKey({ id: "0000000042-0000000001-0000000003", contractId });
    const b = generateIdempotencyKey({ id: "0000000043-0000000001-0000000003", contractId });
    expect(a.key).not.toBe(b.key);
  });

  it("produces different keys when only the tx index differs", () => {
    const a = generateIdempotencyKey({ id: "0000000042-0000000001-0000000003", contractId });
    const b = generateIdempotencyKey({ id: "0000000042-0000000002-0000000003", contractId });
    expect(a.key).not.toBe(b.key);
  });

  it("produces different keys when only the event index differs", () => {
    const a = generateIdempotencyKey({ id: "0000000042-0000000001-0000000003", contractId });
    const b = generateIdempotencyKey({ id: "0000000042-0000000001-0000000004", contractId });
    expect(a.key).not.toBe(b.key);
  });

  it("produces three distinct keys for fixtures differing by one component", () => {
    const base = generateIdempotencyKey({ id: "0000000042-0000000001-0000000003", contractId });
    const ledgerDiff = generateIdempotencyKey({ id: "0000000043-0000000001-0000000003", contractId });
    const txDiff = generateIdempotencyKey({ id: "0000000042-0000000002-0000000003", contractId });
    const eventDiff = generateIdempotencyKey({ id: "0000000042-0000000001-0000000004", contractId });
    const keys = new Set([base.key, ledgerDiff.key, txDiff.key, eventDiff.key]);
    expect(keys.size).toBe(4);
  });

  it("produces the same key for identical components", () => {
    const a = generateIdempotencyKey({ id: "0000000042-0000000001-0000000003", contractId });
    const b = generateIdempotencyKey({ id: "0000000042-0000000001-0000000003", contractId });
    expect(a.key).toBe(b.key);
  });

  it("includes the contract id so two contracts can reuse an event id", () => {
    const a = generateIdempotencyKey({ id: "0000000042-0000000001-0000000003", contractId });
    const b = generateIdempotencyKey({
      id: "0000000042-0000000001-0000000003",
      contractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    expect(a.key).not.toBe(b.key);
  });
});
